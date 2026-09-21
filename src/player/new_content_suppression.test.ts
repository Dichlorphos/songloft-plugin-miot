// 消费待播放上下文时「不要清除自己正在消费的那条 pending」这条抑制规则，必须是逐次调用的。
//
// 原实现把抑制状态放在 manager 级布尔量 `suppressNewContentHook` 上：gracefulPlay 在途期间
// 打开，任何**其它**并发请求（用户在另一处点了新歌单/语音点了新歌）的 clearPending 调用
// 都会被一起抑制掉。结果是新内容已经开始播放，旧的待播放上下文却还留在存储里，
// 之后一次「继续播放」会把旧上下文又推出来。
//
// 接缝：PlaylistManager 的公开方法 + newContentHook 回调计数。

import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigManager } from '../config/manager.ts';
import { PlaylistManager } from './manager.ts';
import { setHostBaseUrl } from '../utils/http.ts';

function installFakeHost(overrides: Record<string, unknown> = {}) {
  (globalThis as any).songloft = {
    storage: { async get() { return null; }, async set() {}, async delete() {} },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    plugin: { async getToken() { return 't'; }, async getHostUrl() { return 'http://127.0.0.1:9999'; } },
    playlists: {
      async getById(id: number) { return { id, sort_by: '', sort_order: 'asc' }; },
      async getSongs() { return []; },
    },
    songs: { async getById() { return null; } },
    ...overrides,
  };
}

function fakeMina() {
  return {
    async playURL() { return true; },
    async pausePlayVerified() { return 'paused' as const; },
    async stopPlay() { return true; },
    async resumePlay() { return true; },
    async getPlayState() { return { status: 1, position: 0, duration: 200 }; },
    async textToSpeech() {},
  };
}

const SONGS = [{ id: 11, type: 'remote', title: 'T', artist: 'A', duration: 200, url: 'u' }];

test('gracefulPlay 在途时，其它请求的新内容清除不得被抑制', async () => {
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  const manager = new PlaylistManager('acc1', 'devB', fakeMina() as any, new ConfigManager());

  const cleared: string[] = [];
  manager.setNewContentHook(async () => { cleared.push('cleared'); });

  // 让 gracefulPlay 卡在加载歌单里，制造「消费在途」的窗口
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let firstLoad = true;
  const base = (globalThis as any).songloft.playlists.getSongs;
  (globalThis as any).songloft.playlists.getSongs = async (...args: unknown[]) => {
    if (firstLoad) { firstLoad = false; await gate; }
    return (base as (...a: unknown[]) => Promise<unknown>)(...args);
  };

  try {
    const consuming = manager.gracefulPlay(7, SONGS[0], 0, 10, 'order' as any, 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // 消费还没结束，用户要求播新内容：这条清除**不属于**正在消费的那次调用
    const newContent = manager.play(7, 0, 'order' as any);
    release();
    await Promise.allSettled([consuming, newContent]);

    assert.equal(
      cleared.length,
      1,
      '其它请求的 clearPending 必须照常执行；只有 gracefulPlay 自己那次才抑制',
    );
  } finally {
    // PlaylistManager 会注册自动切歌定时器：不清理测试进程不会退出
    manager.cleanup();
  }
});

test('gracefulPlay 消费电台时不得清除正在消费的那条 pending', async () => {
  // 抑制路径只在会走 playWithSongs 的分支（电台 / 无正式歌单）上生效：
  // 歌单分支自己加载歌曲、根本不调 notifyNewContent。因此这里必须用电台歌曲，
  // 否则测试无论如何都会通过，锁不住抑制机制。
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  const manager = new PlaylistManager('acc1', 'devB', fakeMina() as any, new ConfigManager());

  const cleared: string[] = [];
  manager.setNewContentHook(async () => { cleared.push('cleared'); });

  const radio = { id: 21, type: 'radio', title: '电台', artist: '', duration: 0, url: 'r' };
  try {
    const ok = await manager.gracefulPlay(0, radio, 0, 0, 'order' as any, 1);

    assert.equal(ok, true);
    assert.deepEqual(cleared, [], '消费电台时不得清掉自己正在消费的那条 pending');
  } finally {
    manager.cleanup();
  }
});

test('消费电台时，并发的其它新内容请求仍要清除 pending', async () => {
  // 这条同时锁住两侧：自己那次抑制、别人那次不抑制。
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  const manager = new PlaylistManager('acc1', 'devB', fakeMina() as any, new ConfigManager());

  let hookCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  manager.setNewContentHook(async () => {
    hookCalls += 1;
    await gate;
  });

  const radio = { id: 21, type: 'radio', title: '电台', artist: '', duration: 0, url: 'r' };
  // gracefulPlay 的电台分支会经 playWithSongs 调 notifyNewContent(consumingPending=true)，
  // 它被抑制、不会卡在 hook 上。
  const consuming = manager.gracefulPlay(0, radio, 0, 0, 'order' as any, 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  // 并发的新内容请求：必须真的走到 hook（而不是被别人的消费抑制掉）
  const other = manager.play(7, 0, 'order' as any);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const callsWhileBlocked = hookCalls;
  release();
  await Promise.allSettled([consuming, other]);

  try {
    assert.equal(callsWhileBlocked, 1, '并发的其它请求必须调用清除钩子，且只调一次');
  } finally {
    manager.cleanup();
  }
});

test('gracefulPlay 结束后，后续新内容请求恢复正常清除', async () => {
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  const manager = new PlaylistManager('acc1', 'devB', fakeMina() as any, new ConfigManager());

  const cleared: string[] = [];
  manager.setNewContentHook(async () => { cleared.push('cleared'); });

  try {
    await manager.gracefulPlay(7, SONGS[0], 0, 10, 'order' as any, 1);
    cleared.length = 0;
    await manager.play(7, 0, 'order' as any);

    assert.equal(cleared.length, 1, '抑制必须随调用结束而失效，不得残留');
  } finally {
    manager.cleanup();
  }
});
