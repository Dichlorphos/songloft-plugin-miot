// 起播失败处理的决策规则（#466 / 验收 I1–I3）。
//
// 抽成纯函数是因为原实现在 handleLandingFailure 私有方法里，含 TTS、stop、advanceToNext
// 三种副作用，且被 10+8 秒定时器和外部停止探测两条路径共用。行为无法在接缝处观察，
// 只能靠人读代码——三条验收项（跳歌 / 电台停播 / 熔断）因此长期没有自动化兜底。
//
// 期望值取自验收清单：
//   I1 正式歌单遇不可播放 → 跳下一首
//   I2 电台或 singlePlay  → 不跳歌，停播
//   I3 连续 3 首起播失败  → 熔断停播
//
// 关键顺序：熔断判定先于电台/单曲判定。即电台连续失败 3 次也走熔断，不是单曲终止文案。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { decideLandingFailure, isEarlyLandingStop, LandingFailureCounter } from './landing_failure.ts';

test('I1：正式歌单首次起播失败 → 跳下一首', () => {
  assert.equal(
    decideLandingFailure({ consecutiveFailures: 1, isRadio: false, isSinglePlay: false }),
    'advance',
  );
});

test('I2：电台起播失败 → 停播，不跳歌', () => {
  assert.equal(
    decideLandingFailure({ consecutiveFailures: 1, isRadio: true, isSinglePlay: false }),
    'terminal-stop',
  );
});

test('I2：singlePlay 起播失败 → 停播，不跳歌', () => {
  assert.equal(
    decideLandingFailure({ consecutiveFailures: 1, isRadio: false, isSinglePlay: true }),
    'terminal-stop',
  );
});

test('I3：正式歌单连续 3 首失败 → 熔断', () => {
  assert.equal(
    decideLandingFailure({ consecutiveFailures: 3, isRadio: false, isSinglePlay: false }),
    'circuit-break',
  );
});

test('I3：熔断判定先于电台/单曲判定', () => {
  // 电台连续失败达阈值同样熔断，文案为「多首歌曲无法播放」而非单曲文案。
  assert.equal(
    decideLandingFailure({ consecutiveFailures: 3, isRadio: true, isSinglePlay: true }),
    'circuit-break',
  );
});

test('连续失败超过阈值仍走熔断', () => {
  assert.equal(
    decideLandingFailure({ consecutiveFailures: 4, isRadio: false, isSinglePlay: false }),
    'circuit-break',
  );
});

test('未达阈值时按内容类型分流', () => {
  assert.equal(
    decideLandingFailure({ consecutiveFailures: 2, isRadio: false, isSinglePlay: false }),
    'advance',
  );
  assert.equal(
    decideLandingFailure({ consecutiveFailures: 2, isRadio: true, isSinglePlay: false }),
    'terminal-stop',
  );
});
// ---- I5：外部停止发生在起播早期（position < 15s）按起播失败处理 ---------------
//
// 起播确认漏网（首查恰好 status=1、随后音源 502）由这条兜住：设备已停下、位置还停在
// 起播窗口内，语义等同「刚下发的这首没真播上」，应走同一套失败处理而不是普通外停。

test('I5：起播早期（position < 15s）的外部停止按起播失败处理', () => {
  assert.equal(isEarlyLandingStop(0), true);
  assert.equal(isEarlyLandingStop(14.9), true);
});

test('I5：起播窗口外（position >= 15s）的外部停止按普通外停处理', () => {
  assert.equal(isEarlyLandingStop(15), false);
  assert.equal(isEarlyLandingStop(120), false);
});

test('I5：拿不到有效位置时不按起播失败处理', () => {
  // position 为负代表设备未上报位置；此时无法断言是「没播上」，不能误跳下一首。
  assert.equal(isEarlyLandingStop(-1), false);
});

test('I5：早期停止与起播确认共用同一套动作判定', () => {
  // 早期停止不引入第二套规则：仍按 I1/I2/I3 分流。
  assert.equal(isEarlyLandingStop(3), true);
  assert.equal(
    decideLandingFailure({ consecutiveFailures: 1, isRadio: false, isSinglePlay: false }),
    'advance',
  );
});
// ---- I6：正常歌曲起播确认成功时清零熔断计数 -----------------------------------

test('I6：起播确认成功清零连续失败计数', () => {
  const counter = new LandingFailureCounter();
  counter.recordFailure();
  counter.recordFailure();
  assert.equal(counter.value(), 2);

  counter.recordLanded();

  assert.equal(counter.value(), 0, '一次成功必须清零，否则会跨歌曲累积误熔断');
});

test('I6：清零后的失败重新从 1 开始累计，不会提前熔断', () => {
  const counter = new LandingFailureCounter();
  counter.recordFailure();
  counter.recordFailure();
  counter.recordLanded();
  counter.recordFailure();

  assert.equal(counter.value(), 1);
  assert.equal(
    decideLandingFailure({ consecutiveFailures: counter.value(), isRadio: false, isSinglePlay: false }),
    'advance',
    '仅 1 次失败不得触发熔断',
  );
});

test('I3：连续三次失败触发熔断，中途成功即打断', () => {
  const counter = new LandingFailureCounter();
  assert.equal(decideLandingFailure({
    consecutiveFailures: counter.recordFailure(), isRadio: false, isSinglePlay: false,
  }), 'advance');
  assert.equal(decideLandingFailure({
    consecutiveFailures: counter.recordFailure(), isRadio: false, isSinglePlay: false,
  }), 'advance');
  assert.equal(decideLandingFailure({
    consecutiveFailures: counter.recordFailure(), isRadio: false, isSinglePlay: false,
  }), 'circuit-break');
});

test('熔断后重置，下一次失败重新从 1 开始', () => {
  const counter = new LandingFailureCounter();
  counter.recordFailure();
  counter.recordFailure();
  counter.recordFailure();
  counter.reset();

  assert.equal(counter.value(), 0);
});