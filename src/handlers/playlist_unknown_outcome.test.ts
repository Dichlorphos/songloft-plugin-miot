// D4 契约：下发结果 unknown 时对外报告 success:false + outcome:'unknown'，
// 不回滚设备、不清除待播放上下文。
//
// 规格第 68 行是这条验收项的判据。此处把真实的 SwitchCoordinator 注入 handler 的
// 模块单例，再驱动真实 createRouter，因此覆盖的是「unknown 从协调器一路传到 HTTP 响应」
// 的完整契约，而不是任一层单独的形状。
//
// 触发 unknown 的真实路径是 host_deps.playPendingContext 的 catch 分支；这里用
// 一个会抛错的 playPlaylist 复刻同一语义，并断言 pending 未被清除。

import test from 'node:test';
import * as assert from 'node:assert/strict';
import { createRouter } from '@songloft/plugin-sdk';

import { registerPlaylistHandlers } from './playlist.ts';
import { SwitchCoordinator } from '../playback_sync/switch_coordinator.ts';
import { PendingContextStore } from '../playback_sync/pending_store.ts';
import { PlaybackSnapshotStore } from '../playback_sync/snapshot_store.ts';
import { setSwitchCoordinator, resetSwitchCoordinatorForTest } from '../playback_sync/index.ts';
import { playPendingContext } from '../playback_sync/host_deps.ts';

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
  storage: { async get() { return null; }, async set() {} },
  plugin: { async getToken() { return 't'; }, async getHostUrl() { return 'http://127.0.0.1:1'; } },
  playlists: { async getById() { return null; }, async getSongs() { return []; } },
  songs: { async getById() { return null; } },
} as any;

function fakeManager() {
  return {
    isPlaying: () => false,
    hasPlaylist: () => true,
    getStatus: () => ({ state: 'stopped', playlist_id: 7, current_index: 0, play_mode: 'order', position: 0 }),
    getCurrentSong: () => ({ id: 11, title: 'T', artist: 'A' }),
    resumePlayback: async () => true,
    pause: async () => {},
    play: async () => true,
    playWithSongs: async () => true,
    playPlaylistFromSong: async () => true,
    setAnnounceOnSongChange() {},
    getPrimary: () => ({ account_id: 'acc1', device_id: 'devB' }),
    getSongs: () => [],
  };
}

function buildRouter() {
  const router = createRouter();
  const manager = fakeManager();
  const map = { get: () => manager, getOrCreate: async () => manager };
  const mina = {
    async getPlayState() { return { status: 1, position: 0, duration: 100 }; },
    async updateLastSelection() { return true; },
    async textToSpeech() {},
  };
  const config = {
    async getConfig() { return { server_host: 'http://192.168.1.10:58091' }; },
    async getDevices() { return []; },
    async getPlaylistProgress() { return null; },
  };
  registerPlaylistHandlers(router as any, map as any, mina as any, config as any);
  return router;
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

/**
 * 装配真实链路：gracefulPlay 抛错 → host_deps.playPendingContext 归为 unknown →
 * 协调器透传 → handler 返回 success:false + outcome:'unknown'。
 *
 * 目标 manager 的 gracefulPlay 模拟 ubus 超时（生产中最常见的「结果不确定」来源）。
 */
async function installUnknownCoordinator() {
  const pendingStore = new PendingContextStore(memoryStorage());
  await pendingStore.write({
    account_id: 'acc1', target_device_id: 'devB', source_revision: 3, snapshot, now: 1_000,
  });

  const manager = {
    setAnnounceOnSongChange() {},
    async gracefulPlay() { throw new Error('ubus timeout'); },
    async playPlaylistFromSong() { return true; },
  };
  const managerMap = {
    async getOrCreate() { return manager; },
    get() { return manager; },
  } as any;

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
      playPendingContext(managerMap, accountId, targetDeviceId, playlistId, song, songIndex, positionSec, mode, speed),
  });
  setSwitchCoordinator(coordinator);
  return pendingStore;
}

test('/player/toggle：真实链路的下发超时返回 success:false 与 outcome:unknown，并保留 pending', async () => {
  const pendingStore = await installUnknownCoordinator();
  try {
    const router = buildRouter();
    const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });

    assert.equal(body.success, false, 'unknown 必须对外报告失败');
    assert.equal(body.outcome, 'unknown', 'outcome 必须如实为 unknown，不得降级为 failed');
    assert.ok(await pendingStore.read('acc1', 'devB', 1_000), 'unknown 不得清除待播放上下文');
  } finally {
    resetSwitchCoordinatorForTest();
  }
});