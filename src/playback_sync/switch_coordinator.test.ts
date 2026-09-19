// 切换编排的纯逻辑测试：只依赖注入的最小能力，不触碰宿主对象。
//
// 这层把「设备选择」与「继续播放」的规则收口：源设备取请求开始时的当前选择，
// 先采样快照再更新当前选择；跨账号、同设备、设备组都不同步。
// pending 的读写去重由 PendingContextStore 负责，这里只验证编排顺序与失效规则。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { SwitchCoordinator } from './switch_coordinator.ts';
import { PendingContextStore, PENDING_CONTEXT_TTL_MS } from './pending_store.ts';
import { PlaybackSnapshotStore } from './snapshot_store.ts';

function memoryStorage() {
  const dump: Record<string, string> = {};
  return {
    async get(key: string) { return Object.prototype.hasOwnProperty.call(dump, key) ? dump[key] : null; },
    async set(key: string, value: string) { dump[key] = value; },
    dump: () => dump,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    account_id: 'acc1',
    content_type: 'playlist' as const,
    song_id: 11,
    playlist_id: 7,
    song_index: 2,
    position_sec: 30,
    position_available: true,
    speed: 1,
    play_mode: 'order',
    state: 'playing' as const,
    source_device: { account_id: 'acc1', device_id: 'devA' },
    updated_at: 1_000,
    revision: 3,
    title: 'T',
    artist: 'A',
    ...overrides,
  };
}

function makeCoordinator(options: {
  snapshot?: ReturnType<typeof snapshot> | null;
  currentDevice?: string | null;
  isGroup?: boolean;
  sampled?: number | null;
} = {}) {
  const snapshotStorage = memoryStorage();
  const pendingStorage = memoryStorage();
  const snapshotStore = new PlaybackSnapshotStore(snapshotStorage);
  const pendingStore = new PendingContextStore(pendingStorage);
  const calls: string[] = [];
  const state: { currentDevice: string | null } = {
    currentDevice: options.currentDevice === undefined ? 'devA' : options.currentDevice,
  };

  if (options.snapshot !== null) {
    snapshotStorage.dump().playback_snapshot_v1 = JSON.stringify({
      schema_version: 1,
      snapshots: { acc1: options.snapshot ?? snapshot() },
    });
  }

  const coordinator = new SwitchCoordinator({
    snapshotStore,
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => state.currentDevice,
    setCurrentDevice: async (_accountId, deviceId) => { state.currentDevice = deviceId; },
    isGroupDevice: async () => !!options.isGroup,
    samplePosition: async () => {
      calls.push('sample');
      return options.sampled === undefined ? 42 : options.sampled;
    },
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async (_accountId, _targetDeviceId, playlistId, song, songIndex, positionSec, mode, _speed) => {
      calls.push(`play:${playlistId}:${song.id}:${songIndex}:${positionSec}:${mode}`);
      return 'succeeded';
    },
  });

  return { coordinator, snapshotStore, pendingStore, calls, state };
}

test('切换写入 pending 并更新当前选择', async () => {
  const { coordinator, pendingStore, calls, state } = makeCoordinator();
  const result = await coordinator.onDeviceSelected('acc1', 'devB');
  assert.equal(result.success, true);
  assert.deepEqual(calls, ['sample']);
  assert.equal(state.currentDevice, 'devB');
  const pending = await pendingStore.read('acc1', 'devB', 10_000);
  assert.ok(pending);
  assert.equal(pending?.snapshot.song_id, 11);
});

test('切换先用采样位置刷新快照，再写 pending', async () => {
  const { coordinator, snapshotStore } = makeCoordinator();
  await coordinator.onDeviceSelected('acc1', 'devB');
  const refreshed = await snapshotStore.read('acc1');
  assert.equal(refreshed?.position_sec, 42);
  assert.equal(refreshed?.revision, 4);
});

test('源与目标相同不创建同步任务', async () => {
  const { coordinator, calls } = makeCoordinator();
  const result = await coordinator.onDeviceSelected('acc1', 'devA');
  assert.equal(result.success, true);
  assert.deepEqual(calls, []);
});

test('无源设备不创建同步任务', async () => {
  const { coordinator, calls } = makeCoordinator({ currentDevice: null });
  const result = await coordinator.onDeviceSelected('acc1', 'devB');
  assert.equal(result.success, true);
  assert.deepEqual(calls, []);
});

test('跨账号切换不共享快照', async () => {
  const { coordinator, calls } = makeCoordinator();
  const result = await coordinator.onDeviceSelected('acc2', 'devB');
  assert.equal(result.success, true);
  assert.deepEqual(calls, []);
});

test('设备组成员完全跳过同步', async () => {
  const { coordinator, calls } = makeCoordinator({ isGroup: true });
  const result = await coordinator.onDeviceSelected('acc1', 'devB');
  assert.equal(result.success, true);
  assert.deepEqual(calls, []);
});

test('采样失败仍保存旧快照的 pending，接口仍成功', async () => {
  const { coordinator, pendingStore, calls } = makeCoordinator({ sampled: null });
  const result = await coordinator.onDeviceSelected('acc1', 'devB');
  assert.equal(result.success, true);
  assert.deepEqual(calls, ['sample']);
  const pending = await pendingStore.read('acc1', 'devB', 10_000);
  assert.ok(pending);
  assert.equal(pending?.snapshot.position_sec, 30);
});

test('继续播放优先消费 pending 并在成功后清除', async () => {
  const { coordinator, pendingStore, calls } = makeCoordinator();
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 3,
    snapshot: snapshot(), now: 10_000,
  });
  const result = await coordinator.tryResumePending('acc1', 'devB');
  assert.equal(result.outcome, 'succeeded');
  assert.deepEqual(calls, ['play:7:11:2:30:order']);
  assert.equal(await pendingStore.read('acc1', 'devB', 10_000), null);
});

test('pending 过期时不消费并报告无上下文', async () => {
  const { coordinator, calls } = makeCoordinator();
  const { pendingStore } = makeCoordinator();
  await pendingStore.write({ account_id: 'acc1', target_device_id: 'devB', source_revision: 3, snapshot: snapshot(), now: 10_000 });
  // 换一个 now 已过期的协调器
  const stale = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(memoryStorage()),
    pendingStore,
    now: () => 10_000 + PENDING_CONTEXT_TTL_MS + 1,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    samplePosition: async () => 42,
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => { calls.push('play'); return 'succeeded'; },
  });
  const result = await stale.tryResumePending('acc1', 'devB');
  assert.equal(result.outcome, 'none');
  assert.deepEqual(calls, []);
});

test('取不到歌曲对象时保留 pending 并报告失败', async () => {
  const snapshotStorage = memoryStorage();
  const pendingStorage = memoryStorage();
  const pendingStore = new PendingContextStore(pendingStorage);
  await pendingStore.write({ account_id: 'acc1', target_device_id: 'devB', source_revision: 3, snapshot: snapshot(), now: 10_000 });
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(snapshotStorage),
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    samplePosition: async () => 42,
    loadSong: async () => null,
    playPlaylist: async () => 'succeeded',
  });
  const result = await coordinator.tryResumePending('acc1', 'devB');
  assert.equal(result.outcome, 'failed');
  assert.ok(await pendingStore.read('acc1', 'devB', 10_000));
});

test('下发成功后清除 pending；失败保留', async () => {
  const { coordinator, pendingStore } = makeCoordinator();
  await pendingStore.write({ account_id: 'acc1', target_device_id: 'devB', source_revision: 3, snapshot: snapshot(), now: 10_000 });
  await coordinator.clearPending('acc1', 'devB');
  assert.equal(await pendingStore.read('acc1', 'devB', 10_000), null);
});

test('选择新内容清除 pending 且发生在加载之前', async () => {
  const { coordinator, pendingStore } = makeCoordinator();
  await pendingStore.write({ account_id: 'acc1', target_device_id: 'devB', source_revision: 3, snapshot: snapshot(), now: 10_000 });
  await coordinator.onNewContentRequested('acc1', 'devB');
  assert.equal(await pendingStore.read('acc1', 'devB', 10_000), null);
});

test('电台 pending 按歌曲身份恢复且位置为 0', async () => {
  const { coordinator, pendingStore, calls } = makeCoordinator();
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 3,
    snapshot: snapshot({ content_type: 'radio', playlist_id: null, position_sec: 0, position_available: false }),
    now: 10_000,
  });
  const result = await coordinator.tryResumePending('acc1', 'devB');
  assert.equal(result.outcome, 'succeeded');
  assert.deepEqual(calls, ['play:0:11:2:0:order']);
});

test('恢复只有命中原 song_id 才恢复位置；回退从 0 开始', async () => {
  const snapshotStorage = memoryStorage();
  const pendingStorage = memoryStorage();
  const pendingStore = new PendingContextStore(pendingStorage);
  await pendingStore.write({ account_id: 'acc1', target_device_id: 'devB', source_revision: 3, snapshot: snapshot(), now: 10_000 });
  const played: Array<{ songId: number; index: number; position: number }> = [];
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(snapshotStorage),
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    samplePosition: async () => 42,
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async (_accountId, _targetDeviceId, _playlistId, song, songIndex, positionSec, _mode, _speed) => {
      played.push({ songId: song.id, index: songIndex, position: positionSec });
      return 'succeeded';
    },
  });
  await coordinator.tryResumePending('acc1', 'devB');
  assert.deepEqual(played, [{ songId: 11, index: 2, position: 30 }]);
});

test('暂停态切换不采样，沿用状态机出口写好的位置', async () => {
  const { coordinator, calls, pendingStore } = makeCoordinator();
  // 默认快照是 playing；改成 paused 后切换不应触发采样
  const paused = snapshot({ state: 'paused', position_sec: 55 });
  const storage = memoryStorage();
  storage.dump().playback_snapshot_v1 = JSON.stringify({ schema_version: 1, snapshots: { acc1: paused } });
  const pendingStorage = memoryStorage();
  const store = new PendingContextStore(pendingStorage);
  const c = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(storage),
    pendingStore: store,
    now: () => 10_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    samplePosition: async () => { calls.push('sample'); return 42; },
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'succeeded',
  });
  await c.onDeviceSelected('acc1', 'devB');
  assert.deepEqual(calls, []);
  const pending = await store.read('acc1', 'devB', 10_000);
  assert.equal(pending?.snapshot.position_sec, 55);
});

test('快速连续切换按最新选择落定，源设备取上一个选择', async () => {
  let current: string | null = 'devA';
  const sources: Array<string | null> = [];
  // 模拟存储写入耗时不同：先发的 devB 慢、后发的 devC 快，
  // 没有串行化时慢的那次会最后落盘，把最新选择覆盖回旧设备。
  const writeDelayMs: Record<string, number> = { devB: 40, devC: 5 };

  const snapshotStorage = memoryStorage();
  snapshotStorage.dump().playback_snapshot_v1 = JSON.stringify({
    schema_version: 1,
    snapshots: { acc1: snapshot() },
  });
  const pendingStore = new PendingContextStore(memoryStorage());

  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(snapshotStorage),
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => { sources.push(current); return current; },
    setCurrentDevice: async (_accountId, deviceId) => {
      await new Promise((resolve) => setTimeout(resolve, writeDelayMs[deviceId] ?? 0));
      current = deviceId;
    },
    isGroupDevice: async () => false,
    samplePosition: async () => 42,
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'succeeded',
  });

  const first = coordinator.onDeviceSelected('acc1', 'devB');
  const second = coordinator.onDeviceSelected('acc1', 'devC');
  await Promise.all([first, second]);

  assert.equal(current, 'devC');
  assert.deepEqual(sources, ['devA', 'devB']);
});
