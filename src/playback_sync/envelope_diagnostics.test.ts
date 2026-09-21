// 本次评审整改的回归测试：信封存储的坏数据诊断、存储读故障与「无数据」的区分、
// 快照出口序号守卫，以及 pending 内层快照的契约校验。
//
// 这些点此前要么完全没覆盖（日志、读故障），要么被静默当成「正常无数据」处理，
// 修起来很便宜但漏了就会以「继续播放播成另一个内容」的形式出现在真机上。

import test from 'node:test';
import assert from 'node:assert/strict';

import { PlaybackSnapshotStore, PLAYBACK_SNAPSHOT_STORAGE_KEY, type PlaybackSnapshot } from './snapshot_store.ts';
import { PendingContextStore, PENDING_CONTEXT_STORAGE_KEY, PENDING_CONTEXT_TTL_MS } from './pending_store.ts';
import type { EnvelopeStorage } from './envelope_store.ts';

/** 能按 key 抛错的存储替身。 */
function memoryStorage(options: { failGet?: (key: string) => Error | null } = {}) {
  const map = new Map<string, string>();
  const storage: EnvelopeStorage & { dump(): Record<string, string> } = {
    async get(key) {
      const failure = options.failGet?.(key);
      if (failure) throw failure;
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    dump() {
      return Object.fromEntries(map);
    },
  };
  return storage;
}

function snapshot(overrides: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot {
  return {
    schema_version: 1,
    account_id: 'acc1',
    content_type: 'playlist',
    song_id: 101,
    playlist_id: 7,
    song_index: 2,
    position_sec: 30,
    position_available: true,
    speed: 1,
    play_mode: 'order',
    state: 'playing',
    source_device: { account_id: 'acc1', device_id: 'dev1' },
    updated_at: 1_000,
    revision: 1,
    title: '歌名',
    artist: '歌手',
    ...overrides,
  };
}

function newSnapshotInput(overrides: Partial<PlaybackSnapshot> = {}) {
  const { schema_version: _s, revision: _r, ...rest } = snapshot(overrides);
  return rest;
}

// ===== 坏条目诊断日志 =====

test('单条坏快照被忽略时留下诊断日志', async () => {
  const storage = memoryStorage();
  await storage.set(PLAYBACK_SNAPSHOT_STORAGE_KEY, JSON.stringify({
    schema_version: 1,
    snapshots: { acc1: { account_id: 'acc1' }, acc2: snapshot({ account_id: 'acc2' }) },
  }));
  const logs: string[] = [];
  const store = new PlaybackSnapshotStore(storage, { log: (m) => logs.push(m) });

  assert.equal(await store.read('acc1'), null);
  assert.equal(logs.length, 1, '一次读取必须留下恰好一条诊断日志');
  assert.match(logs[0], /PlaybackSnapshotStore/, '日志要带来源前缀');
  assert.match(logs[0], /dropped 1/, '日志要说明丢了几个条目');
  assert.ok(await store.read('acc2'), '其它账号的数据必须保留');
});

test('单条坏 pending 被忽略时留下诊断日志', async () => {
  const storage = memoryStorage();
  await storage.set(PENDING_CONTEXT_STORAGE_KEY, JSON.stringify({
    schema_version: 1,
    pending: {
      'acc1:dev2': { account_id: 'acc1' },
      'acc1:dev3': {
        schema_version: 1,
        account_id: 'acc1',
        target_device_id: 'dev3',
        source_revision: 5,
        created_at: 1_000,
        expires_at: 1_000 + PENDING_CONTEXT_TTL_MS,
        snapshot: snapshot(),
      },
    },
  }));
  const logs: string[] = [];
  const store = new PendingContextStore(storage, { log: (m) => logs.push(m) });

  assert.equal(await store.read('acc1', 'dev2', 1_000), null);
  assert.equal(logs.length, 1, '一次读取必须留下恰好一条诊断日志');
  assert.match(logs[0], /PendingContextStore/);
  assert.ok(await store.read('acc1', 'dev3', 1_000), '其它目标的数据必须保留');
});

test('未知 schema 与损坏 JSON 各留诊断，且不清空存储', async () => {
  const storage = memoryStorage();
  const logs: string[] = [];
  const store = new PlaybackSnapshotStore(storage, { log: (m) => logs.push(m) });

  await storage.set(PLAYBACK_SNAPSHOT_STORAGE_KEY, JSON.stringify({ schema_version: 99, snapshots: { acc1: snapshot() } }));
  assert.equal(await store.read('acc1'), null);
  assert.ok(storage.dump()[PLAYBACK_SNAPSHOT_STORAGE_KEY], '未知 schema 不得清空原数据');

  await storage.set(PLAYBACK_SNAPSHOT_STORAGE_KEY, '{ not json');
  assert.equal(await store.read('acc1'), null);
  assert.ok(storage.dump()[PLAYBACK_SNAPSHOT_STORAGE_KEY], '损坏 JSON 不得清空原数据');

  assert.equal(logs.length, 2, '未知 schema 与解析失败各记一条');
});

// ===== 存储读故障 ≠ 无数据 =====

test('快照读取故障时不按空信封写回，避免抹掉其它账号', async () => {
  let fail = false;
  const storage = memoryStorage({
    failGet: () => (fail ? new Error('storage offline') : null),
  });
  await storage.set(PLAYBACK_SNAPSHOT_STORAGE_KEY, JSON.stringify({
    schema_version: 1,
    snapshots: { acc2: snapshot({ account_id: 'acc2' }) },
  }));

  const store = new PlaybackSnapshotStore(storage);
  fail = true;
  const result = await store.write(newSnapshotInput());

  assert.equal(result.ok, false, '读故障时写入必须失败');
  assert.equal(result.reason, 'storage_error');

  fail = false;
  assert.ok(await store.read('acc2'), 'acc2 的快照不能被抹掉');
});

test('pending 读取故障与「没有 pending」必须可区分', async () => {
  let fail = false;
  const storage = memoryStorage({
    failGet: () => (fail ? new Error('storage offline') : null),
  });
  const store = new PendingContextStore(storage);

  assert.deepEqual(await store.readWithStatus('acc1', 'dev2', 1_000), { status: 'none' });

  fail = true;
  const errored = await store.readWithStatus('acc1', 'dev2', 1_000);
  assert.equal(errored.status, 'error', '读故障不得伪装成「没有待播放上下文」');
});

test('pending 读故障时写入失败且不清空既有条目', async () => {
  let fail = false;
  const storage = memoryStorage({
    failGet: () => (fail ? new Error('storage offline') : null),
  });
  const store = new PendingContextStore(storage);
  await store.write({
    account_id: 'acc1', target_device_id: 'dev3', source_revision: 5, snapshot: snapshot(), now: 1_000,
  });

  fail = true;
  const result = await store.write({
    account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot(), now: 1_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'storage_error');

  fail = false;
  assert.ok(await store.read('acc1', 'dev3', 1_000), '既有条目必须保留');
});

// ===== 出口序号守卫 =====

test('迟到的旧出口不得覆盖已经落盘的更新状态', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());

  const newer = await store.write(newSnapshotInput({ state: 'stopped', updated_at: 2_000, position_sec: 12 }), 2);
  const late = await store.write(newSnapshotInput({ state: 'playing', updated_at: 1_000, position_sec: 30 }), 1);

  assert.equal(newer.ok, true);
  assert.equal(late.ok, false, '旧出口序号必须被拒绝');
  assert.equal(late.reason, 'stale');
  assert.equal((await store.read('acc1'))?.state, 'stopped', '落盘的必须仍是新状态');
});

test('同序号与更大序号正常受理', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());

  assert.equal((await store.write(newSnapshotInput(), 1)).ok, true);
  assert.equal((await store.write(newSnapshotInput({ state: 'paused' }), 1)).ok, true, '同序号不算旧');
  assert.equal((await store.write(newSnapshotInput({ state: 'stopped' }), 5)).ok, true, '更新序号必须受理');
  assert.equal((await store.read('acc1'))?.state, 'stopped');
});

test('删除账号会重置该账号的出口序号', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());
  await store.write(newSnapshotInput(), 10);
  await store.remove('acc1');

  const afterReset = await store.write(newSnapshotInput(), 1);
  assert.equal(afterReset.ok, true, '账号删除后序号必须一并重置，新账号从 1 重新开始');
});

// ===== pending 内层快照契约 =====

test('pending 内层快照必须是合法快照，坏的是整条 pending', async () => {
  const storage = memoryStorage();
  const logs: string[] = [];
  const store = new PendingContextStore(storage, { log: (m) => logs.push(m) });

  const base = {
    schema_version: 1,
    account_id: 'acc1',
    source_revision: 5,
    created_at: 1_000,
    expires_at: 1_000 + PENDING_CONTEXT_TTL_MS,
  };
  await storage.set(PENDING_CONTEXT_STORAGE_KEY, JSON.stringify({
    schema_version: 1,
    pending: {
      // 内层快照缺字段 / 类型不对：整条都不该被当作有效 pending
      'acc1:dev2': { ...base, target_device_id: 'dev2', snapshot: { song_id: 1 } },
      // 故意传错类型，构造「内层快照字段类型不对」的坏条
      'acc1:dev3': { ...base, target_device_id: 'dev3', snapshot: snapshot({ song_id: 'not-a-number' as never }) },
    },
  }));

  assert.equal(await store.read('acc1', 'dev2', 1_000), null);
  assert.equal(await store.read('acc1', 'dev3', 1_000), null);
  assert.match(logs[0] ?? '', /dropped 2/);
});

test('pending 内层快照不属于同一账号时按坏条处理', async () => {
  const storage = memoryStorage();
  await storage.set(PENDING_CONTEXT_STORAGE_KEY, JSON.stringify({
    schema_version: 1,
    pending: {
      'acc1:dev2': {
        schema_version: 1,
        account_id: 'acc1',
        target_device_id: 'dev2',
        source_revision: 5,
        created_at: 1_000,
        expires_at: 1_000 + PENDING_CONTEXT_TTL_MS,
        // 快照来自别的账号：跨账号数据不得被当成有效待播放上下文
        snapshot: snapshot({ account_id: 'acc2' }),
      },
    },
  }));
  const store = new PendingContextStore(storage);

  assert.equal(await store.read('acc1', 'dev2', 1_000), null);
});

test('合法 pending 仍能正常读写（守住上面加严后没有误伤）', async () => {
  const store = new PendingContextStore(memoryStorage());
  const write = await store.write({
    account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot(), now: 1_000,
  });

  assert.equal(write.ok, true);
  assert.equal((await store.read('acc1', 'dev2', 1_000))?.snapshot.song_id, 101);
  assert.equal((await store.read('acc1', 'dev2', 1_000 + PENDING_CONTEXT_TTL_MS + 1)), null, '过期仍视为无');
});
