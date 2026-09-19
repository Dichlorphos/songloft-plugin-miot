import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PENDING_CONTEXT_STORAGE_KEY,
  PENDING_CONTEXT_TTL_MS,
  PendingContextStore,
  type PendingContextStorage,
} from './pending_store.ts';
import type { PlaybackSnapshot } from './snapshot_store.ts';

function memoryStorage(): PendingContextStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    dump() {
      return Object.fromEntries(map);
    },
  };
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
    revision: 5,
    title: '歌名',
    artist: '歌手',
    ...overrides,
  };
}

test('切换写入待播放上下文，保存快照完整副本', async () => {
  const store = new PendingContextStore(memoryStorage());

  const result = await store.write({
    account_id: 'acc1',
    target_device_id: 'dev2',
    source_revision: 5,
    snapshot: snapshot(),
    now: 1_000,
  });

  assert.equal(result.ok, true);
  const pending = await store.read('acc1', 'dev2', 1_000);
  assert.equal(pending?.snapshot.song_id, 101);
  assert.equal(pending?.source_revision, 5);
  assert.equal(pending?.target_device_id, 'dev2');
  assert.equal(pending?.created_at, 1_000);
  assert.equal(pending?.expires_at, 1_000 + PENDING_CONTEXT_TTL_MS);
});

test('后续源快照变化不改写已保存的目标内容', async () => {
  const storage = memoryStorage();
  const store = new PendingContextStore(storage);
  const source = snapshot({ song_id: 101 });
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: source, now: 1_000 });

  // 源快照之后被改写：pending 持有的是当时的完整副本，不该跟着变
  source.song_id = 999;

  const pending = await store.read('acc1', 'dev2', 1_000);
  assert.equal(pending?.snapshot.song_id, 101);
});

test('同一账号与目标设备只保留最新一条', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot({ song_id: 1 }), now: 1_000 });
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 6, snapshot: snapshot({ song_id: 2, revision: 6 }), now: 1_100 });

  const pending = await store.read('acc1', 'dev2', 1_100);
  assert.equal(pending?.snapshot.song_id, 2);
  assert.equal(pending?.source_revision, 6);
});

test('不同目标设备分别保留', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot({ song_id: 1 }), now: 1_000 });
  await store.write({ account_id: 'acc1', target_device_id: 'dev3', source_revision: 5, snapshot: snapshot({ song_id: 2 }), now: 1_000 });

  assert.equal((await store.read('acc1', 'dev2', 1_000))?.snapshot.song_id, 1);
  assert.equal((await store.read('acc1', 'dev3', 1_000))?.snapshot.song_id, 2);
});

test('账号之间严格隔离', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot({ song_id: 1 }), now: 1_000 });
  await store.write({ account_id: 'acc2', target_device_id: 'dev2', source_revision: 9, snapshot: snapshot({ account_id: 'acc2', song_id: 2 }), now: 1_000 });

  assert.equal((await store.read('acc1', 'dev2', 1_000))?.snapshot.song_id, 1);
  assert.equal((await store.read('acc2', 'dev2', 1_000))?.snapshot.song_id, 2);
});

test('同一内容与同一 source_revision 去重，不刷新有效期', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot(), now: 1_000 });

  const again = await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot(), now: 1_000 + 60_000 });

  const pending = await store.read('acc1', 'dev2', 1_000 + 60_000);
  assert.equal(again.deduped, true);
  assert.equal(pending?.created_at, 1_000);
  assert.equal(pending?.expires_at, 1_000 + PENDING_CONTEXT_TTL_MS);
});

test('source_revision 变化时替换并重新计时', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot(), now: 1_000 });

  const later = 1_000 + 60_000;
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 6, snapshot: snapshot({ revision: 6 }), now: later });

  const pending = await store.read('acc1', 'dev2', later);
  assert.equal(pending?.created_at, later);
  assert.equal(pending?.expires_at, later + PENDING_CONTEXT_TTL_MS);
});

test('内容变化时替换并重新计时', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot({ song_id: 1 }), now: 1_000 });

  const later = 1_000 + 60_000;
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot({ song_id: 2 }), now: later });

  const pending = await store.read('acc1', 'dev2', later);
  assert.equal(pending?.snapshot.song_id, 2);
  assert.equal(pending?.created_at, later);
});

test('过期待播放上下文按不存在处理', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot(), now: 1_000 });

  assert.ok(await store.read('acc1', 'dev2', 1_000 + PENDING_CONTEXT_TTL_MS));
  assert.equal(await store.read('acc1', 'dev2', 1_000 + PENDING_CONTEXT_TTL_MS + 1), null);
});

test('旧异步任务不得覆盖更新的待播放上下文', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot({ song_id: 1 }), now: 1_000 });
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 6, snapshot: snapshot({ song_id: 2, revision: 6 }), now: 1_100 });

  // 以旧 source_revision 为基准的迟到写入
  const stale = await store.write({
    account_id: 'acc1',
    target_device_id: 'dev2',
    source_revision: 5,
    snapshot: snapshot({ song_id: 1 }),
    now: 1_200,
    base_source_revision: 5,
  });

  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');
  assert.equal((await store.read('acc1', 'dev2', 1_200))?.snapshot.song_id, 2);
});

test('清除某目标的待播放上下文', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot(), now: 1_000 });

  await store.clear('acc1', 'dev2');

  assert.equal(await store.read('acc1', 'dev2', 1_000), null);
});

test('清除某目标不影响其它目标', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot(), now: 1_000 });
  await store.write({ account_id: 'acc1', target_device_id: 'dev3', source_revision: 5, snapshot: snapshot(), now: 1_000 });

  await store.clear('acc1', 'dev2');

  assert.ok(await store.read('acc1', 'dev3', 1_000));
});

test('删除账号清除该账号全部待播放上下文', async () => {
  const store = new PendingContextStore(memoryStorage());
  await store.write({ account_id: 'acc1', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot(), now: 1_000 });
  await store.write({ account_id: 'acc1', target_device_id: 'dev3', source_revision: 5, snapshot: snapshot(), now: 1_000 });
  await store.write({ account_id: 'acc2', target_device_id: 'dev2', source_revision: 5, snapshot: snapshot({ account_id: 'acc2' }), now: 1_000 });

  await store.removeAccount('acc1');

  assert.equal(await store.read('acc1', 'dev2', 1_000), null);
  assert.equal(await store.read('acc1', 'dev3', 1_000), null);
  assert.ok(await store.read('acc2', 'dev2', 1_000));
});

test('未知信封 schema 视为无数据且不清空存储', async () => {
  const storage = memoryStorage();
  await storage.set(PENDING_CONTEXT_STORAGE_KEY, JSON.stringify({ schema_version: 99, pending: { acc1: {} } }));
  const store = new PendingContextStore(storage);

  assert.equal(await store.read('acc1', 'dev2', 1_000), null);
  assert.ok(storage.dump()[PENDING_CONTEXT_STORAGE_KEY]);
});

test('单条坏数据只忽略该条，其它目标保留', async () => {
  const storage = memoryStorage();
  const good = {
    schema_version: 1,
    account_id: 'acc1',
    target_device_id: 'dev3',
    source_revision: 5,
    created_at: 1_000,
    expires_at: 1_000 + PENDING_CONTEXT_TTL_MS,
    snapshot: snapshot(),
  };
  await storage.set(
    PENDING_CONTEXT_STORAGE_KEY,
    JSON.stringify({ schema_version: 1, pending: { 'acc1:dev2': { account_id: 'acc1' }, 'acc1:dev3': good } }),
  );
  const store = new PendingContextStore(storage);

  assert.equal(await store.read('acc1', 'dev2', 1_000), null);
  assert.ok(await store.read('acc1', 'dev3', 1_000));
});

test('存储失败返回失败结果而不抛出', async () => {
  const storage: PendingContextStorage = {
    async get() {
      return null;
    },
    async set() {
      throw new Error('quota exceeded');
    },
  };
  const store = new PendingContextStore(storage);

  const result = await store.write({
    account_id: 'acc1',
    target_device_id: 'dev2',
    source_revision: 5,
    snapshot: snapshot(),
    now: 1_000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'storage_error');
});