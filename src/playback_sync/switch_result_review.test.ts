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
import { PlaybackRecorder, type PlaybackObservation } from './recorder.ts';
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

function observationOf(songId: number, deviceId = 'devA'): PlaybackObservation {
  return {
    account_id: 'acc1',
    content_type: 'playlist',
    song_id: songId,
    playlist_id: 7,
    song_index: 0,
    position_sec: 30,
    position_available: true,
    speed: 1,
    play_mode: 'order',
    state: 'playing',
    source_device: { account_id: 'acc1', device_id: deviceId },
    target_count: 1,
    title: 'T',
    artist: 'A',
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
    playPlaylist: async () => 'dispatched',
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
    playPlaylist: async () => 'dispatched',
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
    playPlaylist: async () => 'dispatched',
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
    playPlaylist: async () => 'dispatched',
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
    playPlaylist: async () => 'dispatched',
  });

  const result = await coordinator.tryResumePending('acc1', 'devB');

  assert.equal(
    result.outcome,
    'failed',
    '读不了 pending 时必须如实报失败：报 none 会让调用方回退到目标原内容并播成另一个东西',
  );
});

test('并发继续播放只下发一次（否则会双重起播/串播）', async () => {
  // 用户快速连点「继续播放」，或网页 toggle 与语音 resume 同时到达时，两路都会走到
  // tryResumePending。若没有互斥，两路都会读到同一条 pending 并各自下发一次播放。
  const pendingStore = new PendingContextStore(memoryStorage());
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 1, snapshot: snapshot(), now: 1_000,
  });

  let plays = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(memoryStorage()),
    pendingStore,
    now: () => 1_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'no_snapshot' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => { plays++; await gate; return 'dispatched'; },
  });

  const first = coordinator.tryResumePending('acc1', 'devB');
  const second = coordinator.tryResumePending('acc1', 'devB');
  // 让两路都跑到「已经读到 pending」之后，再放行第一个下发
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(plays, 1, '同一目标的并发继续必须只下发一次');
  // 后到的一路应当如实报告它没有消费到上下文，而不是假装成功
  assert.deepEqual(
    [a.outcome, b.outcome].sort(),
    ['dispatched', 'in-progress'],
    '确认窗口内后到的一路必须报告 in-progress，既不得重复下发也不得回退目标原内容',
  );
});

test('消费期间被「选择新内容」作废后，不得再按旧上下文下发', async () => {
  // clearPending 会把 storage 里的 pending 删掉，但已经读过 pending、正在等着下发的这一路
  // 手里仍握着快照。若不复查内容代际，它会在新内容已经开始加载之后再把旧上下文推下去。
  const pendingStore = new PendingContextStore(memoryStorage());
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 1, snapshot: snapshot(), now: 1_000,
  });

  let plays = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(memoryStorage()),
    pendingStore,
    now: () => 1_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'no_snapshot' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => { plays++; await gate; return 'dispatched'; },
  });

  const resume = coordinator.tryResumePending('acc1', 'devB');
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  // 下发还没完成，用户先选了新内容
  await coordinator.onNewContentRequested('acc1', 'devB');
  release();
  const result = await resume;

  assert.equal(plays, 1, '下发已经开始，无法撤回：这一路确实下发了一次');
  assert.equal(result.outcome, 'dispatched', '已经下发的这一路如实报告「已受理下发」');
  // 关键：作废之后不得再把 pending 当成「还可以继续消费」的东西留下
  assert.equal(await pendingStore.read('acc1', 'devB', 1_000), null, '新内容已清除 pending，消费不得复活它');
});

test('被作废的消费不得在原下发之前继续（代际复查）', async () => {
  // 与上一条的区别：这里的 playPlaylist 还没开始，代际已变，必须直接放弃。
  const pendingStore = new PendingContextStore(memoryStorage());
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 1, snapshot: snapshot(), now: 1_000,
  });

  let plays = 0;
  let allowLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { allowLoad = resolve; });
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(memoryStorage()),
    pendingStore,
    now: () => 1_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'no_snapshot' as const }),
    loadSong: async (songId) => { await loadGate; return { id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }; },
    playPlaylist: async () => { plays++; return 'dispatched'; },
  });

  const resume = coordinator.tryResumePending('acc1', 'devB');
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  // 此时卡在 loadSong 里，还没下发
  await coordinator.onNewContentRequested('acc1', 'devB');
  allowLoad();
  const result = await resume;

  assert.equal(plays, 0, '代际已变且尚未下发时，必须放弃这次消费');
  assert.equal(result.outcome, 'none', '如实报告「没有可消费的上下文」，让调用方走新内容的正常路径');
});

test('消费队列在异常后仍可用（一次失败不得卡死后续继续）', async () => {
  // 队列本身必须永不 reject：否则一次消费抛错会把该目标后续所有继续操作永久堵死。
  const pendingStore = new PendingContextStore(memoryStorage());
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 1, snapshot: snapshot(), now: 1_000,
  });

  let attempts = 0;
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(memoryStorage()),
    pendingStore,
    now: () => 1_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'no_snapshot' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ubus exploded');
      return 'dispatched';
    },
  });

  const first = await coordinator.tryResumePending('acc1', 'devB');
  assert.equal(first.outcome, 'failed', '第一次抛出按 failed 上报');
  // pending 仍在（失败不得清除），因此第二次应当还能继续消费
  const second = await coordinator.tryResumePending('acc1', 'devB');
  assert.equal(second.outcome, 'dispatched', '队列必须恢复，第二次继续要能正常消费');
  assert.equal(attempts, 2);
});

test('不同目标设备的继续操作互不阻塞', async () => {
  // 互斥只应按「账号 + 目标设备」生效，不能变成全局串行。
  const pendingStore = new PendingContextStore(memoryStorage());
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 1, snapshot: snapshot(), now: 1_000,
  });
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devC', source_revision: 1, snapshot: snapshot(), now: 1_000,
  });

  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(memoryStorage()),
    pendingStore,
    now: () => 1_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'no_snapshot' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async (_a, deviceId) => { started.push(deviceId); await gate; return 'dispatched'; },
  });

  const b = coordinator.tryResumePending('acc1', 'devB');
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const c = coordinator.tryResumePending('acc1', 'devC');
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const bothStarted = started.length;

  release();
  await Promise.all([b, c]);

  assert.equal(bothStarted, 2, '两个不同目标都必须立刻开始，不能被对方的消费挡住');
});

test('采样被判 stale 时改用存储里更新的快照（同一源设备）', async () => {
  // 采样窗口是 2 秒。期间自动切歌会写入一条更新的出口快照，使本次采样写回被判 stale。
  // 此时若仍把「读取时的旧快照」写进 pending，目标设备恢复时会播成已经过去的那首。
  const storage = memoryStorage();
  const snapshotStore = new PlaybackSnapshotStore(storage);
  const recorder = new PlaybackRecorder(snapshotStore, { now: () => 1_000 });
  await recorder.record(observationOf(11));

  const pendingStore = new PendingContextStore(memoryStorage());
  let current = 'devA';
  const coordinator = new SwitchCoordinator({
    snapshotStore,
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => current,
    setCurrentDevice: async (_a, deviceId) => { current = deviceId; },
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => {
      // 采样进行中：源设备自动切到下一首并落盘，本次采样写回因此失败
      await recorder.record(observationOf(22));
      return { ok: false, reason: 'stale' as const };
    },
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'dispatched',
  });

  await coordinator.onDeviceSelected('acc1', 'devB');

  const pending = await pendingStore.read('acc1', 'devB', 10_000);
  assert.equal(pending?.snapshot.song_id, 22, '必须用存储里更新的那首，而不是读取时的旧快照');
});

test('采样被判 stale 但更新的是别的源设备时，不得张冠李戴', async () => {
  // 快照存储是按账号的。若那条更新来自同账号的另一个设备，就不能把它写进本目标的 pending。
  const storage = memoryStorage();
  const snapshotStore = new PlaybackSnapshotStore(storage);
  const recorder = new PlaybackRecorder(snapshotStore, { now: () => 1_000 });
  await recorder.record(observationOf(11, 'devA'));

  const pendingStore = new PendingContextStore(memoryStorage());
  const coordinator = new SwitchCoordinator({
    snapshotStore,
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => {
      // 同账号的另一台设备（devC）抢先写入
      await recorder.record(observationOf(33, 'devC'));
      return { ok: false, reason: 'stale' as const };
    },
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'dispatched',
  });

  await coordinator.onDeviceSelected('acc1', 'devB');

  const pending = await pendingStore.read('acc1', 'devB', 10_000);
  assert.equal(pending?.snapshot.song_id, 11, '别的设备的内容不得写成本目标的待播放上下文');
  assert.equal(pending?.snapshot.source_device.device_id, 'devA');
});

test('采样失败（非 stale）仍保留旧快照，不受本改动影响', async () => {
  const storage = memoryStorage();
  const snapshotStore = new PlaybackSnapshotStore(storage);
  const recorder = new PlaybackRecorder(snapshotStore, { now: () => 1_000 });
  await recorder.record(observationOf(11));

  const pendingStore = new PendingContextStore(memoryStorage());
  const coordinator = new SwitchCoordinator({
    snapshotStore,
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'sample_failed' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'dispatched',
  });

  await coordinator.onDeviceSelected('acc1', 'devB');

  const pending = await pendingStore.read('acc1', 'devB', 10_000);
  assert.equal(pending?.snapshot.song_id, 11, '采样失败保留旧快照');
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
    playPlaylist: async () => 'dispatched',
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
    playPlaylist: async () => 'dispatched',
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
