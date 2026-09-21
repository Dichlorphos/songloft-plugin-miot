// 「继续播放优先消费 pending」的纯逻辑测试。
//
// 规格：明确 resume 也优先使用有效待播放上下文；没有待播放上下文才使用目标原活动上下文。
// 关键点是「handled」——pending 存在时无论成败都不许静默回退到目标原上下文。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { resumePendingFirst, resumePendingIfAvailable } from './resume_pending.ts';

test('pending 消费成功时 handled 且报告 dispatched', async () => {
  const result = await resumePendingFirst({ tryResumePending: async () => ({ outcome: 'dispatched' }) });
  assert.deepEqual(result, { handled: true, outcome: 'dispatched' });
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
// ===== 三入口共用入口（resumePendingIfAvailable）=====

test('共享入口：没有协调器时交回调用方回退目标原上下文', async () => {
  const result = await resumePendingIfAvailable({
    getCoordinator: () => null,
    accountId: 'acc1',
    deviceId: 'dev1',
  });
  assert.deepEqual(result, { handled: false, outcome: 'none' });
});

test('共享入口：把账号与设备原样透传给协调器', async () => {
  const seen: Array<[string, string]> = [];
  const result = await resumePendingIfAvailable({
    getCoordinator: () => ({
      async tryResumePending(accountId, deviceId) {
        seen.push([accountId, deviceId]);
        return { outcome: 'dispatched' as const };
      },
    }),
    accountId: 'acc1',
    deviceId: 'devB',
  });

  assert.deepEqual(seen, [['acc1', 'devB']]);
  assert.deepEqual(result, { handled: true, outcome: 'dispatched' });
});

test('共享入口：协调器抛错时仍按 failed 处理，不回退', async () => {
  const logs: string[] = [];
  const result = await resumePendingIfAvailable({
    getCoordinator: () => ({
      async tryResumePending() { throw new Error('storage down'); },
    }),
    accountId: 'acc1',
    deviceId: 'devB',
    log: (m) => logs.push(m),
  });

  assert.deepEqual(result, { handled: true, outcome: 'failed' });
  assert.equal(logs.length, 1);
});

test('三个继续播放入口都必须走共享入口，不得各写一份分支', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  const playlist = read('../handlers/playlist.ts');
  const engine = read('./engine.ts');

  for (const [name, source] of [['playlist.ts', playlist], ['engine.ts', engine]] as const) {
    assert.match(source, /resumePendingIfAvailable/, `${name} 必须走共享入口`);
    assert.doesNotMatch(source, /resumePendingFirst/, `${name} 不得再直接调用底层函数、各写一套分支`);
  }
  // 两处网页入口（toggle 与 start_position=resume）应共用同一个 helper
  assert.equal(
    (playlist.match(/respondWithPendingIfAny\(/g) ?? []).length,
    3,
    'playlist.ts 应有两处调用 + 一处定义',
  );
});
