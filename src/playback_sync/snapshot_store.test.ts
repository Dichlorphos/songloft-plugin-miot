import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAYBACK_SNAPSHOT_STORAGE_KEY,
  PLAYBACK_SNAPSHOT_TTL_MS,
  PlaybackSnapshotStore,
  type NewPlaybackSnapshot,
  type PlaybackSnapshotStorage,
} from './snapshot_store.ts';

/** 独立内存存储：夹具不得触碰真实宿主存储。 */
function memoryStorage(): PlaybackSnapshotStorage & { dump(): Record<string, string> } {
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

function input(overrides: Partial<NewPlaybackSnapshot> = {}): NewPlaybackSnapshot {
  return {
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
    title: '歌名',
    artist: '歌手',
    updated_at: 1_000,
    ...overrides,
  };
}

test('首次写入分配 revision 1', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());

  const result = await store.write(input());

  assert.equal(result.ok, true);
  assert.equal(result.snapshot?.revision, 1);
  assert.equal((await store.read('acc1'))?.song_id, 101);
});

test('后续写入在账号内单调递增 revision', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());

  await store.write(input({ song_id: 101 }));
  await store.write(input({ song_id: 102 }));
  const third = await store.write(input({ song_id: 103 }));

  assert.equal(third.snapshot?.revision, 3);
  assert.equal((await store.read('acc1'))?.song_id, 103);
});

test('过期 base_revision 的旧任务写入被拒绝且不覆盖新快照', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());

  const first = await store.write(input({ song_id: 101 }));
  const base = first.snapshot!.revision;
  // 另一个更晚的任务先提交，revision 前进
  await store.write(input({ song_id: 102 }));

  const stale = await store.write({ ...input({ song_id: 999 }), base_revision: base });

  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');
  assert.equal((await store.read('acc1'))?.song_id, 102);
});

test('未知信封 schema 视为无快照，且不清空存储', async () => {
  const storage = memoryStorage();
  await storage.set(PLAYBACK_SNAPSHOT_STORAGE_KEY, JSON.stringify({ schema_version: 99, snapshots: { acc1: {} } }));
  const store = new PlaybackSnapshotStore(storage);

  assert.equal(await store.read('acc1'), null);
  assert.ok(storage.dump()[PLAYBACK_SNAPSHOT_STORAGE_KEY]);
});

test('单条坏快照只忽略该条，其它账号数据保留', async () => {
  const storage = memoryStorage();
  const good = { ...input({ account_id: 'acc2' }), schema_version: 1, revision: 1 };
  await storage.set(
    PLAYBACK_SNAPSHOT_STORAGE_KEY,
    JSON.stringify({ schema_version: 1, snapshots: { acc1: { account_id: 'acc1' }, acc2: good } }),
  );
  const store = new PlaybackSnapshotStore(storage);

  assert.equal(await store.read('acc1'), null);
  assert.equal((await store.read('acc2'))?.song_id, 101);
});

test('超过 30 分钟的快照视为过期', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());
  await store.write(input({ updated_at: 1_000 }));

  const snapshot = await store.read('acc1');

  assert.equal(store.isExpired(snapshot!, 1_000 + PLAYBACK_SNAPSHOT_TTL_MS), false);
  assert.equal(store.isExpired(snapshot!, 1_000 + PLAYBACK_SNAPSHOT_TTL_MS + 1), true);
});

test('账号之间严格隔离', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());

  await store.write(input({ account_id: 'acc1', song_id: 101 }));
  await store.write(input({ account_id: 'acc2', song_id: 202 }));

  assert.equal((await store.read('acc1'))?.song_id, 101);
  assert.equal((await store.read('acc2'))?.song_id, 202);
  assert.equal(await store.read('acc3'), null);
  });

test('删除账号只清该账号，新账号 revision 从 1 开始', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());
  await store.write(input({ account_id: 'acc1' }));
  await store.write(input({ account_id: 'acc2' }));

  await store.remove('acc1');

  assert.equal(await store.read('acc1'), null);
  assert.equal((await store.read('acc2'))?.revision, 1);
  assert.equal((await store.write(input({ account_id: 'acc1' }))).snapshot?.revision, 1);
});

test('存储失败返回失败结果而不抛出，不影响调用方', async () => {
  const storage: PlaybackSnapshotStorage = {
    async get() {
      return null;
    },
    async set() {
      throw new Error('quota exceeded');
    },
  };
  const store = new PlaybackSnapshotStore(storage);

  const result = await store.write(input());

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'storage_error');
});
test('并发写入按账号串行，revision 不丢失', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());

  await Promise.all([
    store.write(input({ song_id: 1 })),
    store.write(input({ song_id: 2 })),
    store.write(input({ song_id: 3 })),
  ]);

  const snapshot = await store.read('acc1');
  assert.equal(snapshot?.revision, 3);
});

test('不同账号的并发写入互不阻塞且各自 revision 独立', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());

  await Promise.all([
    store.write(input({ account_id: 'a', song_id: 1 })),
    store.write(input({ account_id: 'b', song_id: 2 })),
    store.write(input({ account_id: 'a', song_id: 3 })),
  ]);

  assert.equal((await store.read('a'))?.revision, 2);
  assert.equal((await store.read('b'))?.revision, 1);
});
test('删除账号后重新写入，revision 从 1 重新开始', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());
  await store.write(input({ song_id: 1 }));
  await store.write(input({ song_id: 2 }));

  await store.remove('acc1');
  const again = await store.write(input({ song_id: 3 }));

  assert.equal(again.snapshot?.revision, 1);
});

test('删除不存在的账号不报错且不影响其它账号', async () => {
  const store = new PlaybackSnapshotStore(memoryStorage());
  await store.write(input({ account_id: 'keep' }));

  await assert.doesNotReject(() => store.remove('missing'));

  assert.equal((await store.read('keep'))?.revision, 1);
});