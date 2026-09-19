// 「继续播放优先消费 pending」的纯逻辑测试。
//
// 规格：明确 resume 也优先使用有效待播放上下文；没有待播放上下文才使用目标原活动上下文。
// 关键点是「handled」——pending 存在时无论成败都不许静默回退到目标原上下文。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { resumePendingFirst } from './resume_pending.ts';

test('pending 消费成功时 handled 且报告 succeeded', async () => {
  const result = await resumePendingFirst({ tryResumePending: async () => ({ outcome: 'succeeded' }) });
  assert.deepEqual(result, { handled: true, outcome: 'succeeded' });
});

test('没有有效 pending 时不接管，交回目标原活动上下文', async () => {
  const result = await resumePendingFirst({ tryResumePending: async () => ({ outcome: 'none' }) });
  assert.deepEqual(result, { handled: false, outcome: 'none' });
});

test('pending 失败不静默回退，仍算 handled 并如实上报 failed', async () => {
  const result = await resumePendingFirst({ tryResumePending: async () => ({ outcome: 'failed' }) });
  assert.deepEqual(result, { handled: true, outcome: 'failed' });
});

test('结果 unknown 同样算 handled，保留待播放上下文', async () => {
  const result = await resumePendingFirst({ tryResumePending: async () => ({ outcome: 'unknown' }) });
  assert.deepEqual(result, { handled: true, outcome: 'unknown' });
});

test('消费过程抛错按 failed 处理并记日志，不回退', async () => {
  const logs: string[] = [];
  const result = await resumePendingFirst({
    tryResumePending: async () => { throw new Error('storage down'); },
    log: (m) => logs.push(m),
  });
  assert.deepEqual(result, { handled: true, outcome: 'failed' });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /storage down/);
});
