// D4 真实链路：设备下发抛错时，结果必须是 unknown 并保留待播放上下文。
//
// 与 playlist_unknown_outcome.test.ts 的分工：那边断言 HTTP 响应形状，但用 mock 直接
// 返回 unknown；这里串起真实的 host_deps.playPendingContext 与 SwitchCoordinator，
// 覆盖 unknown 的**真实产生点**——gracefulPlay 抛错（ubus 超时/网络中断）时，
// playPendingContext 的 catch 分支返回 unknown。
//
// 规格「数据契约」中 unknown 的对外报告要求：下发结果使用 succeeded/failed/unknown；unknown 对外报告
// success:false + outcome:'unknown'，不清除待播放上下文。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { playPendingContext } from './host_deps.ts';
import { SwitchCoordinator } from './switch_coordinator.ts';
import { PendingContextStore } from './pending_store.ts';
import { PlaybackSnapshotStore } from './snapshot_store.ts';

const snapshot = {
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
};

function memoryStorage() {
  const dump: Record<string, string> = {};
  return {
    async get(key: string) { return Object.prototype.hasOwnProperty.call(dump, key) ? dump[key] : null; },
    async set(key: string, value: string) { dump[key] = value; },
  };
}

(globalThis as any).songloft = {
  log: { info() {}, warn() {}, error() {}, debug() {} },
} as any;

/** 目标 manager：gracefulPlay 按用例要求抛错或返回结果。 */
function fakeManagerMap(gracefulPlay: () => Promise<boolean>) {
  const manager = {
    setAnnounceOnSongChange() {},
    gracefulPlay,
    async playPlaylistFromSong() { return true; },
  };
  return {
    async getOrCreate() { return manager; },
    get() { return manager; },
  } as any;
}

test('D4：gracefulPlay 抛错时 playPendingContext 返回 unknown（真实产生点）', async () => {
  const map = fakeManagerMap(async () => { throw new Error('ubus timeout'); });

  const outcome = await playPendingContext(map, 'acc1', 'devB', 7, { id: 11 }, 2, 30, 'order', 1);

  assert.equal(outcome, 'unknown', '下发抛错必须归为 unknown，而不是 failed');
});

test('D4：gracefulPlay 返回 false 时是 failed（设备明确拒绝，不是未知）', async () => {
  const map = fakeManagerMap(async () => false);

  const outcome = await playPendingContext(map, 'acc1', 'devB', 7, { id: 11 }, 2, 30, 'order', 1);

  assert.equal(outcome, 'failed', '设备明确拒绝与结果未知必须区分开');
});

test('D4：unknown 一路透传到协调器，且不清除待播放上下文', async () => {
  const pendingStore = new PendingContextStore(memoryStorage());
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 3, snapshot, now: 1_000,
  });

  // 真实组合：协调器的 playPlaylist 直接指向 host_deps.playPendingContext，
  // 因此 unknown 的产生与传递都是生产代码路径。
  const map = fakeManagerMap(async () => { throw new Error('ubus timeout'); });
  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(memoryStorage()),
    pendingStore,
    now: () => 1_000,
    getCurrentDevice: async () => 'devA',
    setCurrentDevice: async () => {},
    isGroupDevice: async () => false,
    sampleOnSwitch: async () => ({ ok: false, reason: 'no_snapshot' as const }),
    loadSong: async (songId) => ({ id: songId, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }),
    playPlaylist: (accountId, targetDeviceId, playlistId, song, songIndex, positionSec, mode, speed) =>
      playPendingContext(map, accountId, targetDeviceId, playlistId, song, songIndex, positionSec, mode, speed),
  });

  const result = await coordinator.tryResumePending('acc1', 'devB');

  assert.equal(result.outcome, 'unknown', 'unknown 必须一路透传给调用方');
  assert.ok(await pendingStore.read('acc1', 'devB', 1_000), 'unknown 不得清除待播放上下文');
});