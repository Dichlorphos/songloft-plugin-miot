// 采样入口必须唯一：切换时的位置采样只能走任务 01 暴露的 PlaybackRecorder.sampleOnSwitch。
//
// 这条是防回归用的：评审发现过一次「任务 02 把采样+2s 超时在 switch_coordinator 里
// 又实现了一遍，而 recorder.sampleOnSwitch 在生产代码中从未被调用」。同一规则写两处
// 迟早漂移（例如超时阈值只改一边），所以用源码断言把它钉住。

import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('switch_coordinator 不再自带采样实现，只委托 sampleOnSwitch', () => {
  const source = read('./switch_coordinator.ts');

  // 不得再出现自建超时竞速（那是 recorder 的职责）
  assert.doesNotMatch(source, /Promise\.race/, '采样超时竞速应只存在于 recorder.sampleOnSwitch');
  assert.doesNotMatch(source, /setTimeout\(/, '采样计时器应只存在于 recorder.sampleOnSwitch');
  assert.doesNotMatch(source, /SAMPLE_TIMEOUT_MS/, '超时阈值应由 recorder 持有，避免两处漂移');

  // 必须通过注入的 sampleOnSwitch 委托
  assert.match(source, /this\.sampleOnSwitch\(/, '切换采样必须委托注入的 sampleOnSwitch');

  // 不得再直接写快照来落采样位置（写回归 recorder 的 revision 规则）
  assert.doesNotMatch(
    source,
    /snapshotStore\.write\(\{/,
    '采样后的快照写入应归 recorder.sampleOnSwitch，本层不直接写',
  );
});

test('生产接线把 sampleOnSwitch 指向 recorder 入口', () => {
  const main = readFileSync(fileURLToPath(new URL('../main.ts', import.meta.url)), 'utf8');
  assert.match(main, /sampleOnSwitch:.*getPlaybackRecorder\(\)\.sampleOnSwitch/s, 'main 必须注入 recorder.sampleOnSwitch');
});
