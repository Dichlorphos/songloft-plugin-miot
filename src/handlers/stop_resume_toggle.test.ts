// 停止后经 HTTP 恢复：/player/toggle 必须从停止位置继续，而不是从头重播。
//
// 这是规格「快照范围与生命周期」（stop 保存停止前位置，用户明确继续后仍可恢复）的端到端判据。
// 单测 stop_position_resume.test.ts 锁住 PlaylistManager 的契约，这里锁住 handler
// 确实选了那条路径——原先 toggle 走 manager.play(playlistId, index, mode)，
// 位置参数根本传不进去，用户按停止再按继续一定从头开始。

import test from 'node:test';
import * as assert from 'node:assert/strict';
import { createRouter } from '@songloft/plugin-sdk';

import { registerPlaylistHandlers } from './playlist.ts';

(globalThis as any).songloft = {
  log: { info() {}, warn() {}, error() {}, debug() {} },
  storage: { async get() { return null; }, async set() {} },
  plugin: { async getToken() { return 't'; }, async getHostUrl() { return 'http://127.0.0.1:1'; } },
  playlists: { async getById() { return null; }, async getSongs() { return []; } },
  songs: { async getById() { return null; } },
} as any;

/** 记录调用的 manager 替身；state 决定 toggle 走哪条恢复分支。 */
function fakeManager(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const manager = {
    calls,
    isPlaying: () => false,
    hasPlaylist: () => true,
    getStatus: () => ({ state: 'stopped', playlist_id: 7, current_index: 2, play_mode: 'order', position: 0 }),
    getCurrentSong: () => ({ id: 11, title: 'T', artist: 'A' }),
    getSongs: () => [{ id: 11 }],
    resumePlayback: async () => { calls.push('resumePlayback'); return true; },
    replayCurrent: async (s = 0) => { calls.push(`replayCurrent:${s}`); return true; },
    replayCurrentFromStop: async () => { calls.push('replayCurrentFromStop'); return true; },
    play: async (id: number, idx: number) => { calls.push(`play:${id}:${idx}`); return true; },
    playWithSongs: async () => { calls.push('playWithSongs'); return true; },
    pause: async () => {},
    setAnnounceOnSongChange() {},
    getPrimary: () => ({ account_id: 'acc1', device_id: 'devB' }),
    ...overrides,
  };
  return manager;
}

function buildRouter(manager: any) {
  const router = createRouter();
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
    method: 'POST', path, query: '',
    body: new TextEncoder().encode(JSON.stringify(body)), headers: {},
  };
  const res = await router.handle(req);
  const text = typeof res.body === 'string' ? res.body : new TextDecoder().decode(res.body);
  return JSON.parse(text);
}

test('/player/toggle：stopped 态恢复走 replayCurrentFromStop 而非 play 或从头重播', async () => {
  const manager = fakeManager();
  const router = buildRouter(manager);

  const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });

  assert.equal(body.success, true);
  assert.deepEqual(
    manager.calls,
    ['replayCurrentFromStop'],
    `stopped 恢复必须走停止位置恢复路径，实际调用：${manager.calls.join(', ')}`,
  );
});

test('/player/toggle：paused 态恢复走 resumePlayback，不受停止位置逻辑影响', async () => {
  const manager = fakeManager({
    getStatus: () => ({ state: 'paused', playlist_id: 7, current_index: 2, play_mode: 'order', position: 30 }),
  });
  const router = buildRouter(manager);

  const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });

  assert.equal(body.success, true);
  assert.deepEqual(manager.calls, ['resumePlayback'], 'paused 必须走原位续播，不重推 URL');
});