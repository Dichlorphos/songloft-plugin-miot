// PlaylistManager 起播确认结算接缝：landed / not-landed / superseded。
//
// 这条接缝决定待播放上下文何时被清除：协调器把回调传进来，起播确认结算时回调一次。
// 用假时钟推进 10s/18s，避免真等；覆盖三种终态与电台例外。

import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigManager } from '../config/manager.ts';
import { PlaylistManager } from './manager.ts';
import type { LandingResult } from './landing_failure.ts';
import { setHostBaseUrl } from '../utils/http.ts';

function installFakeHost() {
  (globalThis as any).songloft = {
    storage: { async get() { return null; }, async set() {}, async delete() {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    plugin: { async getToken() { return 't'; }, async getHostUrl() { return 'http://127.0.0.1:9999'; } },
    playlists: {
      async getById(id: number) { return { id, sort_by: '', sort_order: 'asc' }; },
      async getSongs() { return [{ id: 11, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }]; },
    },
    songs: { async getById() { return null; } },
  };
}

function fakeMina(status: number) {
  return {
    async playURL() { return true; },
    async pausePlayVerified() { return 'paused' as const; },
    async stopPlay() { return true; },
    async resumePlay() { return true; },
    async getPlayState() { return { status, position: 0, duration: 200 }; },
    async textToSpeech() {},
  };
}

const SONG = { id: 11, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' };

async function drain() { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); }

test('起播确认 status=1 结算为 landed', async (t) => {
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new PlaylistManager('acc1', 'devB', fakeMina(1) as any, new ConfigManager());
  const results: LandingResult[] = [];
  try {
    await manager.gracefulPlay(7, SONG, 0, 0, 'order' as any, 1, { onLandingResult: (r) => { results.push(r); } });
    t.mock.timers.tick(10_000);
    await drain();
    assert.deepEqual(results, ['landed'], '第一轮回读 status=1 即确认起播');
  } finally {
    manager.cleanup();
  }
});

test('两轮均未确认时结算为 not-landed', async (t) => {
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new PlaylistManager('acc1', 'devB', fakeMina(-1) as any, new ConfigManager());
  const results: LandingResult[] = [];
  try {
    await manager.gracefulPlay(7, SONG, 0, 0, 'order' as any, 1, { onLandingResult: (r) => { results.push(r); } });
    t.mock.timers.tick(10_000);
    await drain();
    t.mock.timers.tick(8_000);
    await drain();
    assert.deepEqual(results, ['not-landed'], '10s + 8s 两轮都没确认才判失败');
  } finally {
    manager.cleanup();
  }
});

test('确认窗口内暂停时结算为 superseded', async (t) => {
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new PlaylistManager('acc1', 'devB', fakeMina(1) as any, new ConfigManager());
  const results: LandingResult[] = [];
  try {
    await manager.gracefulPlay(7, SONG, 0, 0, 'order' as any, 1, { onLandingResult: (r) => { results.push(r); } });
    await manager.pause();
    await drain();
    assert.deepEqual(results, ['superseded'], '用户暂停即表示本次恢复结束，不能再按起播成功清除');
  } finally {
    manager.cleanup();
  }
});

test('电台不产生起播确认结论，回调仅结算为 superseded', async (t) => {
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new PlaylistManager('acc1', 'devB', fakeMina(1) as any, new ConfigManager());
  const results: LandingResult[] = [];
  const radio = { id: 21, type: 'radio', title: '电台', artist: '', duration: 0, url: 'r' };
  try {
    await manager.gracefulPlay(0, radio, 0, 0, 'order' as any, 1, { onLandingResult: (r) => { results.push(r); } });
    t.mock.timers.tick(20_000);
    await drain();
    assert.deepEqual(results, ['superseded'], '电台不产生起播确认结论，回调只能被结算为 superseded，不得悬空');
  } finally {
    manager.cleanup();
  }
});

test('cleanup 不是用户操作：不得把在途待播放上下文结算为 superseded', async (t) => {
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new PlaylistManager('acc1', 'devB', fakeMina(1) as any, new ConfigManager());
  const results: LandingResult[] = [];
  await manager.gracefulPlay(7, SONG, 0, 0, 'order' as any, 1, { onLandingResult: (r) => { results.push(r); } });
  // 用户在确认窗口内触发了卸载/热重载：pending 必须保留，不能因清理而清掉。
  manager.cleanup();
  await drain();
  assert.deepEqual(results, [], 'cleanup 不得结算起播确认，pending 保留到确认或过期');
});
