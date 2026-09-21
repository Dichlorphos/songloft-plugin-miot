// 本次评审整改的回归测试：跨账号切换、设备组判定失败、清洁停机标记清除失败，
// 以及「pending 读故障不得静默回退」。
//
// 这四条都会在真机上表现为「看起来正常、实际播错内容或不该出声时出声」，
// 纯逻辑层能直接锁住，不该留到真机验收才发现。

import test from 'node:test';
import assert from 'node:assert/strict';

import { SwitchCoordinator } from './switch_coordinator.ts';
import { PendingContextStore, PENDING_CONTEXT_STORAGE_KEY, PENDING_CONTEXT_TTL_MS } from './pending_store.ts';
import { PlaybackSnapshotStore, type PlaybackSnapshot } from './snapshot_store.ts';
import type { EnvelopeStorage } from './envelope_store.ts';
import { isDeviceInGroup } from './host_deps.ts';

function memoryStorage(options: { failGet?: boolean } = {}): EnvelopeStorage {
  const map = new Map<string, string>();
  return {
    async get(key) {
      if (options.failGet) throw new Error('storage offline');
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key, value) {
      map.set(key, value);
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
    source_device: { account_id: 'acc1', device_id: 'devA' },
    updated_at: 1_000,
    revision: 1,
    title: '歌名',
    artist: '歌手',
    ...overrides,
  };
}

async function seededSnapshotStorage(accountId = 'acc1', deviceId = 'devA') {
  const storage = memoryStorage();
  const now = 10_000;
  const record = snapshot({ account_id: accountId, source_device: { account_id: accountId, device_id: deviceId }, updated_at: now });
  await storage.set('playback_snapshot_v1', JSON.stringify({ schema_version: 1, snapshots: { [accountId]: record } }));
  return storage;
}

// ===== 跨账号切换 =====

test('跨账号切换只更新选择，不创建同步任务', async () => {
  // acc1 有可同步的快照，且 acc1 自己也有「当前选择」devA。
  // 关键：若不识别跨账号，协调器会拿 acc1 的 devA 当源设备照常同步——本用例就会变红。
  const snapshotStorage = await seededSnapshotStorage('acc1', 'devA');
  const pendingStore = new PendingContextStore(memoryStorage());
  let current: string | null = 'devA';

  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(snapshotStorage),
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => current,
    setCurrentDevice: async (_a, deviceId) => { current = deviceId; },
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: true, snapshot: snapshot() }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'succeeded',
  });

  const selected = await coordinator.onDeviceSelected('acc1', 'devB', 'acc2');

  assert.equal(selected.success, true, '选择提交仍要成功');
  assert.equal(selected.synced, false, '跨账号切换不得同步');
  assert.equal(current, 'devB', '当前选择仍要更新');
  assert.equal(await pendingStore.read('acc1', 'devB', 10_000), null, '不得给目标设备写 pending');
});

test('同账号切换不受 from_account_id 影响，照常同步', async () => {
  const snapshotStorage = await seededSnapshotStorage('acc1', 'devA');
  const pendingStore = new PendingContextStore(memoryStorage());
  let current = 'devA';
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(snapshotStorage),
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => current,
    setCurrentDevice: async (_a, deviceId) => { current = deviceId; },
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'sample_failed' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'succeeded',
  });

  const selected = await coordinator.onDeviceSelected('acc1', 'devB', 'acc1');

  assert.equal(selected.synced, true, '同账号必须照常同步');
  assert.ok(await pendingStore.read('acc1', 'devB', 10_000));
});

test('首次选择（没有来源账号）不会因空串被误判为跨账号', async () => {
  const snapshotStorage = await seededSnapshotStorage('acc1', 'devA');
  const pendingStore = new PendingContextStore(memoryStorage());
  let current = 'devA';
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(snapshotStorage),
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => current,
    setCurrentDevice: async (_a, deviceId) => { current = deviceId; },
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'sample_failed' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'succeeded',
  });

  const selected = await coordinator.onDeviceSelected('acc1', 'devB', '');

  assert.equal(selected.synced, true, '空来源账号只表示「本来没选过」，不是跨账号');
});

// ===== 设备组判定失败必须保守跳过 =====

test('设备组判定失败时按设备组跳过同步，不放行', async () => {
  const snapshotStorage = await seededSnapshotStorage('acc1', 'devA');
  const pendingStore = new PendingContextStore(memoryStorage());
  let current = 'devA';
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(snapshotStorage),
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => current,
    setCurrentDevice: async (_a, deviceId) => { current = deviceId; },
    isGroupDevice: async () => { throw new Error('config read failed'); },
    sampleOnSwitch: async () => ({ ok: true, snapshot: snapshot() }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'succeeded',
  });

  const result = await coordinator.onDeviceSelected('acc1', 'devB');

  assert.equal(result.success, true, '选择本身仍要成功');
  assert.equal(result.synced, false, '无法排除设备组时必须跳过');
  assert.equal(result.reason, 'group');
  assert.equal(await pendingStore.read('acc1', 'devB', 10_000), null, '不得写 pending');
});

test('isDeviceInGroup 读配置失败时抛出，而不是返回 false', async () => {
  const configManager = {
    async getDeviceGroups() { throw new Error('config read failed'); },
  } as never;

  await assert.rejects(
    () => isDeviceInGroup(configManager, 'acc1', 'devA'),
    /config read failed/,
    '返回 false 等于宣称「这是独立设备」，必须抛出交给调用方保守处理',
  );
});

// ===== pending 读故障不得静默回退 =====

test('pending 读故障时 tryResumePending 报 failed，而不是 none', async () => {
  const pendingStorage = memoryStorage({ failGet: true });
  const pendingStore = new PendingContextStore(pendingStorage);
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(memoryStorage()),
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'no_snapshot' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'succeeded',
  });

  const result = await coordinator.tryResumePending('acc1', 'devB');

  assert.equal(
    result.outcome,
    'failed',
    '读不了 pending 时必须如实报失败：报 none 会让调用方回退到目标原内容并播成另一个东西',
  );
});

test('确实没有 pending 时仍返回 none，保持既有回退行为', async () => {
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(memoryStorage()),
    pendingStore: new PendingContextStore(memoryStorage()),
    now: () => 10_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'no_snapshot' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'succeeded',
  });

  assert.equal((await coordinator.tryResumePending('acc1', 'devB')).outcome, 'none');
});

test('过期 pending 视为 none，不因存储里还有残留而报错', async () => {
  const storage = memoryStorage();
  const pendingStore = new PendingContextStore(storage);
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 1, snapshot: snapshot(), now: 1_000,
  });
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(memoryStorage()),
    pendingStore,
    now: () => 1_000 + PENDING_CONTEXT_TTL_MS + 1,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'no_snapshot' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'succeeded',
  });

  assert.equal((await coordinator.tryResumePending('acc1', 'devB')).outcome, 'none');
});

// ===== 存储键契约 =====

test('pending 与快照仍分属两个独立存储键', async () => {
  const storage = memoryStorage();
  const snapshotStore = new PlaybackSnapshotStore(storage);
  const pendingStore = new PendingContextStore(storage);

  await snapshotStore.write({
    ...snapshot(), revision: undefined, schema_version: undefined,
  } as never);
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 1, snapshot: snapshot(), now: 1_000,
  });

  const raw = await storage.get(PENDING_CONTEXT_STORAGE_KEY);
  assert.ok(raw, 'pending 写在 playback_pending_v1');
  const envelope = JSON.parse(raw!);
  assert.equal(envelope.schema_version, 1);
  assert.ok(envelope.pending['acc1:devB']);

  const snapshotRaw = await storage.get('playback_snapshot_v1');
  assert.ok(snapshotRaw, '快照写在 playback_snapshot_v1');
  assert.equal(JSON.parse(snapshotRaw!).snapshots.acc1.song_id, 101);
});
