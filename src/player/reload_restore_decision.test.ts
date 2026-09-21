// 重启恢复判定的纯逻辑测试。
//
// reload_restore_guard.test.ts 走的是 PlaylistManager 的公开路径（端到端，含设备替身）；
// 这份直接喂 planReloadRestore / decideReloadTakeover 的输入，把每条规则单独钉住：
// 以前这些规则埋在 resumeAfterReload 的异步流程里，只能靠读完整段代码才敢改。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { planReloadRestore, decideReloadTakeover, clampStopPosition } from './reload_restore_decision.ts';

const base = {
  anchorState: 'playing',
  anchorPositionSec: 30,
  anchorAtMs: 1_000_000,
  anchorSeekOffsetSec: 0,
  matchesCurrentSong: true,
  allowTakeover: true,
  now: 1_000_000,
  speed: 1,
};

// ===== 第一步：锚点分类 =====

test('锚点歌曲与当前歌曲不符：什么都不做', () => {
  assert.deepEqual(planReloadRestore({ ...base, matchesCurrentSong: false }), { action: 'ignore' });
});

test('位置非法（负数 / 非有限值）：什么都不做', () => {
  assert.deepEqual(planReloadRestore({ ...base, anchorPositionSec: -1 }), { action: 'ignore' });
  assert.deepEqual(planReloadRestore({ ...base, anchorPositionSec: Number.NaN }), { action: 'ignore' });
});

test('不可恢复的状态（idle / 未知）：什么都不做', () => {
  assert.deepEqual(planReloadRestore({ ...base, anchorState: 'idle' }), { action: 'ignore' });
  assert.deepEqual(planReloadRestore({ ...base, anchorState: 'bogus' }), { action: 'ignore' });
});

test('paused：只还原本地状态，不查设备', () => {
  assert.deepEqual(
    planReloadRestore({ ...base, anchorState: 'paused', anchorPositionSec: 42 }),
    { action: 'restore-paused', positionSec: 42 },
  );
});

test('stopped：只还原本地状态，绝不重推 URL', () => {
  assert.deepEqual(
    planReloadRestore({ ...base, anchorState: 'stopped', anchorPositionSec: 7 }),
    { action: 'restore-stopped', positionSec: 7 },
  );
});

test('playing 且允许接管：必须去查设备，不能直接接管', () => {
  const plan = planReloadRestore(base);
  assert.equal(plan.action, 'query-device');
});

test('playing 但上次不是正常卸载：直接钉死，连设备都不查', () => {
  const plan = planReloadRestore({ ...base, allowTakeover: false });
  assert.equal(plan.action, 'pin-stopped');
  if (plan.action !== 'pin-stopped') return;
  assert.match(plan.reason, /not clean/);
});

test('playing 按倍速外推位置，用于没接管时的停止位置', () => {
  const plan = planReloadRestore({ ...base, anchorPositionSec: 30, now: 1_000_000 + 10_000, speed: 1.5 });
  assert.equal(plan.action, 'query-device');
  if (plan.action !== 'query-device') return;
  assert.equal(plan.estimatedPositionSec, 30 + 15, '10 墙钟秒 × 1.5 = 15 曲内秒');
});

test('旧数据缺 atMs：不外推出天文数字位置', () => {
  const plan = planReloadRestore({ ...base, anchorAtMs: 0, anchorPositionSec: 12, now: 1_700_000_000_000 });
  assert.equal(plan.action, 'query-device');
  if (plan.action !== 'query-device') return;
  assert.equal(plan.estimatedPositionSec, 12, '缺 atMs 时按「刚写下」处理');
});

test('旧数据缺 seekOffsetSec：退化为 0（流长判据更保守）', () => {
  const plan = planReloadRestore({ ...base, anchorSeekOffsetSec: 0 });
  assert.equal(plan.action, 'query-device');
  if (plan.action !== 'query-device') return;
  assert.equal(plan.anchorSeekOffsetSec, 0);
});

// ===== 第二步：硬条件判定 =====

const takeoverBase = {
  estimatedPositionSec: 50,
  anchorSeekOffsetSec: 0,
  speed: 1,
};

test('拿不到设备状态：钉死 stopped，不重推 URL', () => {
  const d = decideReloadTakeover({ ...takeoverBase, deviceState: null, streamMatch: 'unknown' });
  assert.equal(d.action, 'pin-stopped');
  if (d.action !== 'pin-stopped') return;
  assert.match(d.reason, /unavailable/);
});

test('设备状态查询失败（status < 0）：钉死 stopped', () => {
  const d = decideReloadTakeover({
    ...takeoverBase, deviceState: { status: -1, position: 0, duration: 0 }, streamMatch: 'unknown',
  });
  assert.equal(d.action, 'pin-stopped');
});

test('设备没在播（status !== 1）：钉死 stopped，绝不被叫醒', () => {
  const d = decideReloadTakeover({
    ...takeoverBase, deviceState: { status: 0, position: 0, duration: 200 }, streamMatch: 'ours',
  });
  assert.equal(d.action, 'pin-stopped');
});

test('设备在播但流长对不上（在放别的媒体）：钉死 stopped', () => {
  const d = decideReloadTakeover({
    ...takeoverBase, deviceState: { status: 1, position: 10, duration: 999 }, streamMatch: 'foreign',
  });
  assert.equal(d.action, 'pin-stopped');
  if (d.action !== 'pin-stopped') return;
  assert.match(d.reason, /not verifiably playing/);
});

test('设备在播但流长未上报（unknown）：信息不足时保守钉死', () => {
  const d = decideReloadTakeover({
    ...takeoverBase, deviceState: { status: 1, position: 10, duration: 0 }, streamMatch: 'unknown',
  });
  assert.equal(d.action, 'pin-stopped', "unknown 不算硬证据");
});

test('设备在播且流长对上：接管定时器，并用设备实测位置', () => {
  const d = decideReloadTakeover({
    ...takeoverBase, deviceState: { status: 1, position: 44, duration: 200 }, streamMatch: 'ours',
  });
  assert.deepEqual(d, { action: 'takeover', devicePositionSec: 44 });
});

test('接管时设备没上报位置：退回外推值', () => {
  const d = decideReloadTakeover({
    ...takeoverBase, estimatedPositionSec: 61, deviceState: { status: 1, position: 0, duration: 200 }, streamMatch: 'ours',
  });
  assert.deepEqual(d, { action: 'takeover', devicePositionSec: 61 });
});

test('接管时设备位置是流内偏移，要按 seek 与倍速换算成曲内绝对位置', () => {
  const d = decideReloadTakeover({
    ...takeoverBase,
    anchorSeekOffsetSec: 20,
    speed: 1.5,
    deviceState: { status: 1, position: 10, duration: 200 },
    streamMatch: 'ours',
  });
  assert.deepEqual(d, { action: 'takeover', devicePositionSec: 20 + 15 });
});

// ===== 钉死位置的夹取 =====

test('钉死位置夹进歌曲时长', () => {
  assert.equal(clampStopPosition(500, 200), 200);
  assert.equal(clampStopPosition(-3, 200), 0);
  assert.equal(clampStopPosition(30, 200), 30);
  assert.equal(clampStopPosition(30, 0), 30, '未知时长时原样保留');
});
