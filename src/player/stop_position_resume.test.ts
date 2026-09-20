// 停止后恢复必须从停止位置继续，而不是从头重播。
//
// 规格「快照范围与生命周期」：pause 保存暂停位置；stop 保存停止前位置并标记 `stopped`。
// stopped 不自动起播，用户明确继续后仍可恢复。
//
// 实际缺陷：stop() 确实把位置存进了 lastStopPositionSec，但那个字段只被写进快照，
// 恢复路径（replayCurrent 默认 seek=0）从不读它。于是用户按停止再按继续，
// 会从整首开头重播——「保存停止前位置」这一条等于白存。
//
// 接缝：PlaylistManager 的公开方法（stop / resumePlayback / replayCurrent），
// 通过 MinaService 替身观察下发的 URL 里是否带 seek 参数。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { ConfigManager } from '../config/manager.ts';
import { PlaylistManager, PlaylistManagerMap } from './manager.ts';
import { setHostBaseUrl } from '../utils/http.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 记录下发 URL 的 MinaService 替身。 */
function makeFakeMina() {
  const urls: string[] = [];
  return {
    urls,
    async playURL(_accountId: string, _deviceId: string, url: string) {
      urls.push(url);
      return true;
    },
    async pausePlayVerified() { return 'paused' as const; },
    async pausePlay() { return true; },
    async resumePlay() { return true; },
    async stopPlay() { return true; },
    async getPlayState() { return { status: 1, position: 0, duration: 200 }; },
    async textToSpeech() {},
  };
}

/** 内存 storage 的宿主替身；不触碰真实用户数据。 */
function installFakeHost() {
  const storage = new Map<string, string>();
  (globalThis as any).songloft = {
    storage: {
      async get(key: string) { return storage.has(key) ? storage.get(key)! : null; },
      async set(key: string, value: string) { storage.set(key, value); },
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    plugin: {
      async getToken() { return 't'; },
      async getHostUrl() { return 'http://127.0.0.1:9999'; },
    },
    playlists: {
      async getById(id: number) { return { id, sort_by: '', sort_order: 'asc' }; },
      async getSongs() { return []; },
    },
    songs: { async getById() { return null; } },
  };
  return { storage };
}

/** 推进到「已起播且播了 N 秒」的状态。 */
async function playingManager(playedSec: number) {
  installFakeHost();
  setHostBaseUrl('http://127.0.0.1:9999');
  const config = new ConfigManager();
  const mina = makeFakeMina();
  const manager = new PlaylistManager('acc1', 'devA', mina as any, config);
  manager.initWithSongs(
    [{ id: 11, type: 'remote', title: 'T', artist: 'A', duration: 200, url: '/api/v1/songs/11/play' } as any],
    0,
    'order',
    7,
  );
  // 直接把 playStartTimeMs 回拨，模拟已经播了 playedSec 秒。
  (manager as any).state = 'playing';
  (manager as any).playStartTimeMs = Date.now() - playedSec * 1000;
  (manager as any).streamSeekOffsetSec = 0;
  return { manager, mina, config };
}

test('停止后恢复：带停止位置重推 URL，而不是从头播', async () => {
  const { manager, mina } = await playingManager(42);
  try {
  await manager.stop();
  const stoppedPosition = (manager as any).lastStopPositionSec;
  assert.ok(Math.abs(stoppedPosition - 42) < 2, `停止位置应约为 42，实际 ${stoppedPosition}`);

  mina.urls.length = 0;
  await manager.replayCurrentFromStop();

  assert.equal(mina.urls.length, 1, '应重推一次 URL');
  assert.match(mina.urls[0], /seek=4[0-4]/, `URL 应带停止位置附近的 seek，实际 ${mina.urls[0]}`);
  } finally { manager.cleanup(); }
});

test('停止位置未知（0）时不带 seek，保持从头播的既有行为', async () => {
  const { manager, mina } = await playingManager(0);
  try {
  await manager.stop();
  mina.urls.length = 0;
  await manager.replayCurrentFromStop();

  assert.equal(mina.urls.length, 1);
  assert.doesNotMatch(mina.urls[0], /seek=[1-9]/, '位置为 0 时应从头播');
  } finally { manager.cleanup(); }
});

test('暂停后恢复仍走原位续播，不受停止位置影响', async () => {
  const { manager, mina } = await playingManager(30);
  try {
  await manager.pause();
  mina.urls.length = 0;
  const ok = await manager.resumePlayback();

  assert.equal(ok, true, '暂停后应能恢复');
  // hardStopped=false 时走裸 resume 指令，不重推 URL。
  assert.equal(mina.urls.length, 0, '真暂停后应复用设备媒体上下文，不重推 URL');
  } finally { manager.cleanup(); }
});

test('清除停止位置：重新起播新歌单后不再沿用旧的停止位置', async () => {
  const { manager } = await playingManager(50);
  try {
  await manager.stop();
  assert.ok((manager as any).lastStopPositionSec > 0);

  manager.initWithSongs(
    [{ id: 99, type: 'remote', title: 'N', artist: 'B', duration: 100, url: '/u' } as any],
    0, 'order', 8,
  );
  (manager as any).state = 'playing';

  assert.equal((manager as any).lastStopPositionSec, 0, '换歌单后不得沿用旧歌单的停止位置');
  } finally { manager.cleanup(); }
});
test('停止位置不会跨会话残留：第二次停止覆盖第一次', async () => {
  const { manager } = await playingManager(20);
  try {
    await manager.stop();
    const first = (manager as any).lastStopPositionSec;
    assert.ok(first > 15 && first < 25, `首次停止位置应约 20，实际 ${first}`);

    // 重新起播并播到另一个位置后再次停止
    (manager as any).state = 'playing';
    (manager as any).playStartTimeMs = Date.now() - 90 * 1000;
    await manager.stop();
    const second = (manager as any).lastStopPositionSec;

    assert.ok(second > 85 && second < 95, `二次停止位置应约 90，实际 ${second}`);
    assert.notEqual(Math.round(first), Math.round(second), '不得残留上一次的位置');
  } finally { manager.cleanup(); }
});

test('initWithSongs 清空停止位置，避免新歌单沿用旧位置', async () => {
  const { manager } = await playingManager(60);
  try {
    await manager.stop();
    assert.ok((manager as any).lastStopPositionSec > 0, '停止位置应已记录');

    manager.initWithSongs(
      [{ id: 77, type: 'remote', title: 'X', artist: 'Y', duration: 100, url: '/u' } as any],
      0, 'order', 9,
    );

    assert.equal((manager as any).lastStopPositionSec, 0, '换内容必须清空停止位置');
  } finally { manager.cleanup(); }
});
test('自动切歌硬失败收尾清空停止位置（位置不可信时不跳到旧位置）', async () => {
  const { manager } = await playingManager(40);
  try {
    await manager.stop();
    assert.ok((manager as any).lastStopPositionSec > 30, '先记录一个旧位置');

    // 自动切歌失败那条路径也把状态设为 stopped，但它不经过 stop()，此前会残留旧位置。
    // 该处 currentIndex 已指向新歌、playStartTimeMs 仍是上一首的，位置没有可信来源，
    // 因此必须显式清空，宁可从头播也不要跳到跨歌的错位置。
    const src = readFileSync(fileURLToPath(new URL('./manager.ts', import.meta.url)), 'utf8');
    const tail = src.slice(src.indexOf('Auto-next failed after retry, stopping'), src.indexOf('Auto-next failed after retry, stopping') + 900);
    assert.match(tail, /this\.lastStopPositionSec = 0;/, '硬失败收尾必须清空停止位置');
  } finally { manager.cleanup(); }
});
test('换歌后不得沿用上一首的停止位置（跨歌 seek 防护）', async () => {
  const { manager } = await playingManager(70);
  try {
    await manager.stop();
    assert.ok((manager as any).lastStopPositionSec > 60, '第一首记录了停止位置');

    // 起播第二首（next 走 playCurrent，是全部换歌路径的汇聚出口）
    manager.initWithSongs(
      [
        { id: 21, type: 'remote', title: 'A', artist: 'X', duration: 200, url: '/u1' } as any,
        { id: 22, type: 'remote', title: 'B', artist: 'Y', duration: 200, url: '/u2' } as any,
      ],
      0, 'order', 7,
    );
    (manager as any).state = 'playing';
    (manager as any).playStartTimeMs = Date.now();
    await manager.next();

    assert.equal(
      (manager as any).lastStopPositionSec, 0,
      '新歌起播后必须清空上一首的停止位置',
    );
  } finally { manager.cleanup(); }
});
test('重复停止不得擦掉已记录的停止位置', async () => {
  const { manager } = await playingManager(55);
  try {
    await manager.stop();
    const recorded = (manager as any).lastStopPositionSec;
    assert.ok(recorded > 45 && recorded < 65, `首次停止应记录 ~55，实际 ${recorded}`);

    // 已是 stopped 时再敲一次停止（用户连点、或语音重复下达）。
    // getPosition() 在非 playing 态恒返回 0，若无条件覆写就会把位置擦成 0，
    // 之后「继续」退化从头播——用户感知是「停止两次后丢失进度」。
    await manager.stop();

    const after = (manager as any).lastStopPositionSec;
    assert.ok(after > 45 && after < 65, `重复停止后位置应仍是 ~55，实际 ${after}`);
  } finally { manager.cleanup(); }
});

test('重复停止后恢复仍从原位置继续', async () => {
  const { manager, mina } = await playingManager(48);
  try {
    await manager.stop();
    await manager.stop();

    mina.urls.length = 0;
    await manager.replayCurrentFromStop();

    assert.equal(mina.urls.length, 1);
    assert.match(mina.urls[0], /seek=4[6-9]|seek=50/, `应从原位置继续，实际 ${mina.urls[0]}`);
  } finally { manager.cleanup(); }
});
test('暂停被设备升级为硬停时，停止位置取本次暂停位置而非上次残留', async () => {
  // 让假 MinaService 模拟「设备忽略 pause、实为 stop」，这样 pause() 内部会走
  // hardStopped 分支——直接赋值 hardStopped 会绕过被测逻辑。
  const { manager } = await playingManager(10);
  try {
    await manager.stop(); // 先留下一个旧停止位置（~10s）
    assert.ok((manager as any).lastStopPositionSec > 5, '旧停止位置已记录');

    // 重播到 80s，并让 pause 被升级为硬停
    (manager as any).state = 'playing';
    (manager as any).playStartTimeMs = Date.now() - 80 * 1000;
    (manager as any).streamSeekOffsetSec = 0;
    (manager as any).minaService.pausePlayVerified = async () => 'stopped';
    await manager.pause();

    assert.equal((manager as any).hardStopped, true, '应识别为硬停');
    const from = (manager as any).lastStopPositionSec;
    assert.ok(
      from > 70 && from < 90,
      `硬停时应以本次暂停位置（~80s）为准，而不是残留旧值，实际 ${from}`,
    );
  } finally { manager.cleanup(); }
});

test('停止位置落在曲尾安全边界内时退化为从头播（歌曲实际已播完）', async () => {
  const song = { id: 11, type: 'remote', title: 'T', artist: 'A', duration: 200, url: '/u' } as any;
  const { manager, mina } = await playingManager(0);
  try {
    // 把停止位置放到 duration-3 之后（例如播完自然停止记下 200s）
    (manager as any).lastStopPositionSec = 200;
    (manager as any).state = 'stopped';
    mina.urls.length = 0;

    await manager.replayCurrentFromStop();

    assert.equal(mina.urls.length, 1);
    assert.doesNotMatch(
      mina.urls[0],
      /seek=1[0-9][0-9]|seek=200/,
      `接近曲尾的停止位置应退化为从头播，实际 ${mina.urls[0]}`,
    );
  } finally { manager.cleanup(); }
});

test('电台停止位置退化：直播流没有曲内位置', async () => {
  const { manager, mina } = await playingManager(0);
  try {
    (manager as any).songs = [
      { id: 11, type: 'radio', title: 'R', artist: 'A', duration: 0, url: '/r', is_live: true } as any,
    ];
    (manager as any).currentIndex = 0;
    (manager as any).lastStopPositionSec = 30;
    (manager as any).state = 'stopped';
    mina.urls.length = 0;

    await manager.replayCurrentFromStop();

    assert.equal(mina.urls.length, 1);
    assert.doesNotMatch(mina.urls[0], /seek=30/, '电台不应带曲内 seek');
  } finally { manager.cleanup(); }
});