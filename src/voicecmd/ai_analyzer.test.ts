// AIAnalyzer.parseResponse 的解析契约测试。
//
// 真实模型常把 JSON 包在 markdown 代码块里，或在前面带思考标签；
// 解析器必须始终提取出合法 JSON，否则语音/AI 指令会静默退化。

import test from 'node:test';
import * as assert from 'node:assert/strict';

(globalThis as any).songloft = {
  log: { info() {}, warn() {}, error() {}, debug() {} },
} as any;

const { AIAnalyzer } = await import('./ai_analyzer.ts');
const analyzer = new AIAnalyzer();

test('parseResponse：纯 JSON 直接解析', () => {
  const raw = '{"action":"resume","params":{},"confidence":"high","rawText":"继续播放"}';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'resume');
  assert.equal(res.confidence, 'high');
  assert.equal(res.rawText, '继续播放');
});

test('parseResponse：解析 markdown 代码块包裹的响应', () => {
  const raw = '```json\n{"action":"unknown","params":{},"confidence":"high","rawText":"太吵了小点声"}\n```';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'unknown');
  assert.equal(res.confidence, 'high');
  assert.equal(res.rawText, '太吵了小点声');
});

test('parseResponse：代码块前后有解释文字也能解析', () => {
  const raw = '分析如下：\n```json\n{"action":"set_play_mode","params":{"mode":"random"},"confidence":"high","rawText":"随机播放"}\n```\n希望有帮助';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'set_play_mode');
  assert.equal(res.params.mode, 'random');
  assert.equal(res.confidence, 'high');
});

test('parseResponse：带 think 标签也能解析', () => {
  const raw = '<think>用户说太吵了</think>\n```json\n{"action":"unknown","params":{},"confidence":"medium","rawText":"太吵了"}\n```';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'unknown');
  assert.equal(res.confidence, 'medium');
});

test('parseResponse：尾部多余花括号文本中提取合法 JSON', () => {
  const raw = 'prefix {"action":"pause","params":{},"confidence":"low","rawText":"暂停"} suffix {tail}';
  const res = analyzer.parseResponse(raw);
  assert.equal(res.action, 'pause');
  assert.equal(res.confidence, 'low');
  assert.equal(res.rawText, '暂停');
});
