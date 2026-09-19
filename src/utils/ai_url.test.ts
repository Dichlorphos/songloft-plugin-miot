// AI 接口地址归一化测试。
//
// 覆盖用户常见填法：裸域名、带 /v1、各类尾斜杠，以及脱敏行为。
// 这些组合曾导致 /v1/v1/models 重复前缀（#106）。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { normalizeAiBaseUrl, aiModelsUrl, aiChatCompletionsUrl, maskUrl } from './ai_url.ts';

test('normalizeAiBaseUrl：裸域名补 /v1', () => {
  assert.equal(normalizeAiBaseUrl('https://api.example.com'), 'https://api.example.com/v1');
});

test('normalizeAiBaseUrl：已含 /v1 不重复拼接', () => {
  assert.equal(normalizeAiBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
});

test('normalizeAiBaseUrl：DashScope 风格路径保留自身前缀', () => {
  assert.equal(
    normalizeAiBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
  );
});

test('normalizeAiBaseUrl：去尾斜杠与首尾空白', () => {
  assert.equal(normalizeAiBaseUrl('  https://api.example.com/v1/  '), 'https://api.example.com/v1');
  assert.equal(normalizeAiBaseUrl(''), '');
});

test('aiModelsUrl 与 aiChatCompletionsUrl：同一 base 推导，不出现 /v1/v1', () => {
  assert.equal(aiModelsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/models');
  assert.equal(aiChatCompletionsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
  assert.ok(!aiModelsUrl('https://api.example.com/v1').includes('/v1/v1'));
});

test('normalizeAiBaseUrl：识别 /v3 等非 v1 版本段，避免错拼成 /v3/v1', () => {
  assert.equal(
    normalizeAiBaseUrl('https://ark.cn-beijing.volces.com/api/v3'),
    'https://ark.cn-beijing.volces.com/api/v3',
  );
  assert.equal(
    aiChatCompletionsUrl('https://ark.cn-beijing.volces.com/api/v3'),
    'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  );
});

test('normalizeAiBaseUrl：识别 /v4（智谱）与 /v2', () => {
  assert.equal(
    normalizeAiBaseUrl('https://open.bigmodel.cn/api/paas/v4'),
    'https://open.bigmodel.cn/api/paas/v4',
  );
  assert.equal(normalizeAiBaseUrl('https://host/v2'), 'https://host/v2');
});

test('maskUrl：去掉 query 与 hash', () => {
  assert.equal(maskUrl('https://api.example.com/v1/models?key=secret#x'), 'https://api.example.com/v1/models');
});
