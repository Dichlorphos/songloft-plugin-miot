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

function buildRouter(manager: any, configOverrides: Record<string, unknown> = {}) {
  const router = createRouter();
  const map = { get: () => manager, getOrCreate: async () => manager };
  const mina = {
    async getPlayState() { return { status: 1, position: 0, duration: 100 }; },
    async updateLastSelection() { return true; },
    async textToSpeech() {},
  };
  const config = {
    async getConfig() { return { server_host: 'http://192.168.1.10:58091', ...configOverrides }; },
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

// ===== 失败分支：不得把没播上的报成成功 =====
//
// toggle 的最后一段是「重新下发」的兜底路径。它有三个出口，任何一个返回失败都必须
// 如实上报 success:false；否则前端会显示成已恢复播放，而音箱并没有出声。

test('/player/toggle：stopped 态 replayCurrentFromStop 失败必须报失败', async () => {
  const manager = fakeManager({
    replayCurrentFromStop: async () => { return false; },
  });
  const router = buildRouter(manager);

  const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });

  assert.equal(body.success, false, '恢复失败不得报成功');
  assert.match(body.error, /resume playback/);
});

test('/player/toggle：普通歌单重新下发失败必须报失败', async () => {
  // 非 stopped、非临时歌单的兜底分支：paused 下 resumePlayback 失败会走到这里。
  const manager = fakeManager({
    getStatus: () => ({ state: 'paused', playlist_id: 7, current_index: 2, play_mode: 'order', position: 30 }),
    resumePlayback: async () => false,
    play: async () => false,
  });
  const router = buildRouter(manager);

  const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });

  assert.equal(body.success, false, 'play() 返回 false 时必须报失败，而不是谎报 succeeded');
});

test('/player/toggle：临时歌单重新下发失败必须报失败', async () => {
  const manager = fakeManager({
    getStatus: () => ({ state: 'idle', playlist_id: -1, current_index: 0, play_mode: 'order', position: 0 }),
    playWithSongs: async () => false,
  });
  const router = buildRouter(manager);

  const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });

  assert.equal(body.success, false, '临时歌单重放失败不得报成功');
});

test('/player/toggle：未配置服务器地址时直接报错，不下发', async () => {
  const manager = fakeManager();
  const router = buildRouter(manager, { server_host: '' });

  const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });

  assert.equal(body.success, false);
  assert.match(body.error, /服务器地址/);
  assert.deepEqual(manager.calls, [], '配置不全时不得向设备下发任何东西');
});

test('/player/toggle：服务器地址是回环时直接报错，不下发', async () => {
  const manager = fakeManager();
  const router = buildRouter(manager, { server_host: 'http://127.0.0.1:58091' });

  const body = await call(router, '/player/toggle', { account_id: 'acc1', device_id: 'devB' });

  assert.equal(body.success, false);
  assert.match(body.error, /回环地址/);
  assert.deepEqual(manager.calls, [], '音箱访问不到回环地址，不得下发');
});
