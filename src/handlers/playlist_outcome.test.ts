// /player/toggle 与 /player/play 的响应契约测试（真实 Router，不 mock SDK）。
//
// 规格第 70 行：`toggle`、明确 resume 和实际播放接口返回 `outcome`；
// 第 68 行：unknown 对外报告 success:false + outcome:'unknown'。
//
// 这里用 SDK 的真实 createRouter 注册 handler，再用真实 HTTPRequest 驱动，
// 只把 PlaylistManagerMap / MinaService / ConfigManager 换成最小替身，
// 因为本测试只关心响应的形状，不关心播放行为。

import test from 'node:test';
import * as assert from 'node:assert/strict';
import { createRouter } from '@songloft/plugin-sdk';

import { registerPlaylistHandlers } from './playlist.ts';

(globalThis as any).songloft = {
  log: { info() {}, warn() {}, error() {}, debug() {} },
  storage: {
    async get() { return null; },
    async set() {},
  },
  plugin: { async getToken() { return 't'; }, async getHostUrl() { return 'http://127.0.0.1:1'; } },
  playlists: { async getById() { return null; }, async getSongs() { return []; } },
} as any;

/** 构造一个只满足 handler 用到的部分的最小 manager。 */
function fakeManager(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function buildHandler(managerOverrides: Record<string, unknown> = {}, minaOverrides: Record<string, unknown> = {}) {
  const router = createRouter();
  const manager = fakeManager(managerOverrides);

  const map = {
    get: () => manager,
    getOrCreate: async () => manager,
  };
  const mina = {
    async getPlayState() { return { status: 1, position: 0, duration: 100 }; },
    async updateLastSelection() { return true; },
    ...minaOverrides,
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
  // SDK 的 HTTPRequest：query 是字符串、body 是 Uint8Array | null。
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

test('toggle：暂停分支返回 outcome', async () => {
  const router = buildHandler({ isPlaying: () => true, pause: async () => {} });
  const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });
  assert.equal(body.success, true);
  assert.equal(body.data?.outcome, 'succeeded');
});

test('toggle：paused 恢复分支返回 outcome', async () => {
  const router = buildHandler({
    getStatus: () => ({ state: 'paused', playlist_id: 7, current_index: 0, play_mode: 'order', position: 5 }),
    resumePlayback: async () => true,
  });
  const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });
  assert.equal(body.success, true);
  assert.equal(body.data?.outcome, 'succeeded');
});

test('toggle：重播分支返回 outcome', async () => {
  const router = buildHandler({
    getStatus: () => ({ state: 'stopped', playlist_id: 7, current_index: 0, play_mode: 'order', position: 0 }),
  });
  const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });
  assert.equal(body.success, true);
  assert.equal(body.data?.outcome, 'succeeded');
});

test('player/play：普通起播成功分支返回 outcome', async () => {
  const router = buildHandler();
  const body = await call(router, '/player/play', { account_id: 'acc1', device_id: 'devB', playlist_id: 7 });
  assert.equal(body.success, true);
  assert.equal(body.data?.outcome, 'succeeded');
});
