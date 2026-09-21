// /mina/last_selection 的接线回归测试。
//
// 规范要求设备选择接口始终成功，但选择写入不能晚于响应：前端会在响应后立刻读取
// 新设备状态。采样等同步工作则应留在后台，不能拖慢选择响应。
//
// 本测试用真实 Router 与真实 SwitchCoordinator，只替身宿主 API 与无用依赖。

import test from 'node:test';
import * as assert from 'node:assert/strict';
import { createRouter } from '@songloft/plugin-sdk';

import { registerDeviceHandlers } from './device.ts';
import { SwitchCoordinator } from '../playback_sync/switch_coordinator.ts';
import { PendingContextStore } from '../playback_sync/pending_store.ts';
import { PlaybackSnapshotStore } from '../playback_sync/snapshot_store.ts';
import { resetSwitchCoordinatorForTest, setSwitchCoordinator } from '../playback_sync/index.ts';

(globalThis as any).songloft = {
  log: { info() {}, warn() {}, error() {}, debug() {} },
  storage: {
    async get() { return null; },
    async set() {},
  },
} as any;

function memoryStorage() {
  const dump: Record<string, string> = {};
  return {
    async get(key: string) { return Object.prototype.hasOwnProperty.call(dump, key) ? dump[key] : null; },
    async set(key: string, value: string) { dump[key] = value; },
    dump: () => dump,
  };
}

async function call(router: any, path: string, body: Record<string, unknown>) {
  const req = {
    method: 'POST',
    path,
    query: '',
    body: new TextEncoder().encode(JSON.stringify(body)),
    headers: {},
  };
  const res = await router.handle(req);
  const text = typeof res.body === 'string' ? res.body : new TextDecoder().decode(res.body);
  return JSON.parse(text);
}

test('last_selection：当前选择写入失败时返回失败', async () => {
  const storage = memoryStorage();
  const pendingStore = new PendingContextStore(memoryStorage());
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(storage),
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => { throw new Error('write failed'); },
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: true }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'dispatched',
  });

  setSwitchCoordinator(coordinator);
  const router = createRouter();
  registerDeviceHandlers(router as any, {} as any, {} as any, {} as any, {} as any);

  try {
    const body = await call(router, '/mina/last_selection', { account_id: 'acc1', device_id: 'devB' });
    assert.equal(body.success, false, '选择未落盘不得返回成功');
    assert.match(body.error, /failed to update last selection/);
  } finally {
    resetSwitchCoordinatorForTest();
  }
});

test('last_selection：响应前提交选择，采样留在后台', async () => {
  const snapshotStorage = memoryStorage();
  snapshotStorage.dump().playback_snapshot_v1 = JSON.stringify({
    schema_version: 1,
    snapshots: {
      acc1: {
        schema_version: 1,
        account_id: 'acc1',
        content_type: 'playlist',
        song_id: 11,
        playlist_id: 7,
        song_index: 0,
        position_sec: 30,
        position_available: true,
        speed: 1,
        play_mode: 'order',
        state: 'playing',
        source_device: { account_id: 'acc1', device_id: 'devA' },
        updated_at: 1_000,
        revision: 1,
        title: 'T',
        artist: 'A',
      },
    },
  });

  let current = 'devA';
  let releaseSample!: () => void;
  const sampleGate = new Promise<void>((resolve) => { releaseSample = resolve; });
  let sampleFinished = false;
  const pendingStore = new PendingContextStore(memoryStorage());
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(snapshotStorage),
    pendingStore,
    now: () => 10_000,
    getCurrentDevice: async () => current,
    setCurrentDevice: async (_accountId, deviceId) => { current = deviceId; },
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => {
      await sampleGate;
      sampleFinished = true;
      return { ok: true };
    },
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: async () => 'dispatched',
  });

  setSwitchCoordinator(coordinator);
  const router = createRouter();
  registerDeviceHandlers(router as any, {} as any, {} as any, {} as any, {} as any);

  try {
    const body = await call(router, '/mina/last_selection', { account_id: 'acc1', device_id: 'devB' });

    assert.equal(body.success, true);
    assert.equal(current, 'devB', '响应返回时当前选择必须已经落盘');
    assert.equal(sampleFinished, false, '响应不得等待后台采样');

    releaseSample();
    for (let i = 0; i < 50; i++) {
      if (await pendingStore.read('acc1', 'devB', 10_000)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(await pendingStore.read('acc1', 'devB', 10_000), '后台同步最终应写入 pending');
  } finally {
    resetSwitchCoordinatorForTest();
  }
});
