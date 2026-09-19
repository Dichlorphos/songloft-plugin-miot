// 切换编排的宿主集成测试。
//
// 与 switch_coordinator.test.ts 的纯逻辑测试不同：这里装配真实的 ConfigManager、
// PlaylistManagerMap 与 PlaylistManager，只把宿主 songloft 与 MinaService 换成内存 fake。
// 验收规范要求集成场景检查：切换不发控制命令、继续才发 URL、成功清除/失败保留、设备组跳过。
//
// 夹具只写内存 storage，绝不触碰真实用户数据。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { ConfigManager } from '../config/manager.ts';
import { AccountManager } from '../account/manager.ts';
import { PlaylistManagerMap } from '../player/manager.ts';
import { setHostBaseUrl } from '../utils/http.ts';
import { SwitchCoordinator } from './switch_coordinator.ts';
import { PendingContextStore } from './pending_store.ts';
import { PlaybackSnapshotStore } from './snapshot_store.ts';
import { createHostPendingStorage, createHostSnapshotStorage, getPlaybackRecorder, resetPlaybackRecorderForTest } from './index.ts';
import { isDeviceInGroup, loadSongById, playPendingContext, sampleSourcePosition } from './host_deps.ts';

/** 内存版 songloft 宿主；记录控制命令，绝不出网。 */
function installFakeHost(options: { songMissing?: boolean; playlistMissing?: boolean } = {}) {
  const storage = new Map<string, string>();
  const controlCalls: string[] = [];

  const songs = new Map<number, any>();
  songs.set(11, {
    id: 11, type: 'remote', title: 'T', artist: 'A', album: '', duration: 200,
    url: '/api/v1/songs/11/play', cover_url: '', lyric_url: '', is_live: false,
  });

  const fake = {
    storage: {
      async get(key: string) { return storage.has(key) ? storage.get(key)! : null; },
      async set(key: string, value: string) { storage.set(key, value); },
    },
    log: {
      info() {}, warn() {}, error() {}, debug() {},
    },
    plugin: {
      async getToken() { return 'test-token'; },
      async getHostUrl() { return 'http://127.0.0.1:9999'; },
    },
    playlists: {
      async getById(id: number) { return options.playlistMissing ? null : { id, sort_by: '', sort_order: 'asc' }; },
      async getSongs() {
        return options.playlistMissing ? [] : [songs.get(11)];
      },
    },
    songs: {
      async getById(id: number) { return options.songMissing ? null : (songs.get(id) ?? null); },
    },
  };

  (globalThis as any).songloft = fake;
  return { storage, controlCalls };
}

/** 记录控制命令的 MinaService 替身；切换路径不得触发其中任何一个。 */
function makeFakeMina(controlCalls: string[], playState = { status: 1, position: 30, duration: 200 }) {
  return {
    async playURL(_a: string, deviceId: string, url: string) {
      controlCalls.push(`playURL:${deviceId}:${url}`);
      return true;
    },
    async pausePlay(_a: string, deviceId: string) { controlCalls.push(`pause:${deviceId}`); return true; },
    async resumePlay(_a: string, deviceId: string) { controlCalls.push(`resume:${deviceId}`); return true; },
    async stopPlay(_a: string, deviceId: string) { controlCalls.push(`stop:${deviceId}`); return true; },
    async getPlayState() { return playState; },
  };
}

async function buildHarness(options: { groups?: any[]; songMissing?: boolean; playState?: any } = {}) {
  const { storage, controlCalls } = installFakeHost({ songMissing: options.songMissing });
  setHostBaseUrl('http://127.0.0.1:9999');

  if (options.groups) storage.set('device_groups', JSON.stringify(options.groups));

  // 单例 recorder 会缓存首个 fake storage；每个用例安装新 fake 后必须重置，避免跨用例串数据。
  resetPlaybackRecorderForTest();
  const configManager = new ConfigManager();
  const accountManager = new AccountManager(configManager);
  const mina = makeFakeMina(controlCalls, options.playState);
  const playlistManagerMap = new PlaylistManagerMap(mina as any, configManager);
  await playlistManagerMap.refreshGroups();

  const coordinator = new SwitchCoordinator({
    snapshotStore: new PlaybackSnapshotStore(createHostSnapshotStorage()),
    pendingStore: new PendingContextStore(createHostPendingStorage()),
    getCurrentDevice: (accountId) => accountManager.getLastSelectedDevice(accountId),
    setCurrentDevice: async (accountId, deviceId) => accountManager.setLastSelectedDevice(accountId, deviceId),
    isGroupDevice: (accountId, deviceId) => isDeviceInGroup(configManager, accountId, deviceId),
    // 与生产接线一致：采样规则归任务 01 的 recorder.sampleOnSwitch。
    sampleOnSwitch: (accountId, deviceId) => getPlaybackRecorder().sampleOnSwitch({
      account_id: accountId,
      device_id: deviceId,
      samplePosition: () =>
        sampleSourcePosition(playlistManagerMap.get(accountId, deviceId), mina, accountId, deviceId),
    }),
    loadSong: (songId) => loadSongById(songId),
    playPlaylist: (accountId, targetDeviceId, playlistId, song, songIndex, positionSec, mode, speed) =>
      playPendingContext(playlistManagerMap, accountId, targetDeviceId, playlistId, song, songIndex, positionSec, mode, speed),
    log: () => {},
  });

  // 种子：账号已选中 devA，且账号级快照指向 devA 正在播放的正式歌单。
  await accountManager.createAccount('acc1', 'password');
  await accountManager.setLastSelectedDevice('acc1', 'devA');
  const snapshotStore = new PlaybackSnapshotStore(createHostSnapshotStorage());
  await snapshotStore.write({
    account_id: 'acc1', content_type: 'playlist', song_id: 11, playlist_id: 7,
    song_index: 2, position_sec: 30, position_available: true, speed: 1, play_mode: 'order',
    state: 'playing', source_device: { account_id: 'acc1', device_id: 'devA' },
    updated_at: Date.now(), title: 'T', artist: 'A',
  });

  return { coordinator, configManager, accountManager, playlistManagerMap, controlCalls, snapshotStore };
}

/** 跑一个用例并确保清理 manager 的自动切歌定时器，否则 node --test 会被定时器挂住不退出。 */
async function withHarness(
  run: (h: Awaited<ReturnType<typeof buildHarness>>) => Promise<void>,
  options: Parameters<typeof buildHarness>[0] = {},
): Promise<void> {
  const h = await buildHarness(options);
  try {
    await run(h);
  } finally {
    h.playlistManagerMap.cleanup();
  }
}

test('集成：切换设备不发任何播放控制命令，只写 pending', async () => {
  await withHarness(async (h) => {
    const result = await h.coordinator.onDeviceSelected('acc1', 'devB');

    assert.equal(result.success, true);
    assert.deepEqual(h.controlCalls, [], '切换不得触发 playURL/pause/resume/stop');
    assert.equal(await h.accountManager.getLastSelectedDevice('acc1'), 'devB');

    const pending = await new PendingContextStore(createHostPendingStorage()).read('acc1', 'devB', Date.now());
    assert.ok(pending, '切换应写入待播放上下文');
    assert.equal(pending?.snapshot.song_id, 11);
  });
});

test('集成：切换用源设备物理位置刷新快照（采样 30s）', async () => {
  await withHarness(async (h) => {
    await h.coordinator.onDeviceSelected('acc1', 'devB');
    const refreshed = await h.snapshotStore.read('acc1');
    assert.equal(refreshed?.position_sec, 44);
    assert.equal(refreshed?.revision, 2);
  }, { playState: { status: 1, position: 44, duration: 200 } });
});

test('集成：继续播放才下发 URL，成功后清除 pending', async () => {
  await withHarness(async (h) => {
    await h.coordinator.onDeviceSelected('acc1', 'devB');
    assert.deepEqual(h.controlCalls, [], '切换阶段不应下发');

    const result = await h.coordinator.tryResumePending('acc1', 'devB');

    assert.equal(result.outcome, 'succeeded');
    assert.equal(h.controlCalls.length, 1, '继续时才下发一次');
    assert.match(h.controlCalls[0], /^playURL:devB:/);
    // 恢复使用固定采样位置：URL 必须带 seek=30
    assert.match(h.controlCalls[0], /seek=30/);

    const pending = await new PendingContextStore(createHostPendingStorage()).read('acc1', 'devB', Date.now());
    assert.equal(pending, null, '成功起播后清除 pending');
  });
});

test('集成：取不到歌曲对象时不下发，保留 pending 并报告失败', async () => {
  await withHarness(async (h) => {
    await h.coordinator.onDeviceSelected('acc1', 'devB');

    const result = await h.coordinator.tryResumePending('acc1', 'devB');

    assert.equal(result.outcome, 'failed');
    assert.deepEqual(h.controlCalls, [], '取不到歌曲不得下发');
    const pending = await new PendingContextStore(createHostPendingStorage()).read('acc1', 'devB', Date.now());
    assert.ok(pending, '失败必须保留 pending');
  }, { songMissing: true });
});

test('集成：歌单为空时加载阶段失败，不下发且保留 pending', async () => {
  await withHarness(async (h) => {
    await h.coordinator.onDeviceSelected('acc1', 'devB');
    // 让目标设备侧歌单加载失败：清掉歌曲列表
    (globalThis as any).songloft.playlists.getSongs = async () => [];

    const result = await h.coordinator.tryResumePending('acc1', 'devB');

    assert.equal(result.outcome, 'failed');
    assert.deepEqual(h.controlCalls, [], '加载阶段失败不得下发任何命令');
    const pending = await new PendingContextStore(createHostPendingStorage()).read('acc1', 'devB', Date.now());
    assert.ok(pending, '歌单为空必须保留 pending');
  });
});

test('集成：任一侧属于设备组时完全跳过同步', async () => {
  await withHarness(async (h) => {
    const result = await h.coordinator.onDeviceSelected('acc1', 'devB');

    assert.equal(result.success, true);
    assert.equal(result.synced, false, '组成员不同步');
    assert.deepEqual(h.controlCalls, [], '组场景不得下发控制命令');
    assert.equal(await h.accountManager.getLastSelectedDevice('acc1'), 'devB', '当前选择仍要更新');
    const pending = await new PendingContextStore(createHostPendingStorage()).read('acc1', 'devB', Date.now());
    assert.equal(pending, null, '组成员不写 pending');
  }, { groups: [{ id: 'grp_1', name: 'g', members: [{ account_id: 'acc1', device_id: 'devA' }, { account_id: 'acc1', device_id: 'devG' }], created_at: '', updated_at: '' }] });
});
