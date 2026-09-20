// 语音口令的 pause / stop 分离（规格「语音行为」、验收 G4）。
//
// 规格：普通语音和 AI 区分 pause、stop、resume；旧 AI 返回 `stop` 始终按停止处理，
// 只有明确解析为 `pause` 才暂停。
//
// 这条长期没有实现：代码里只有 stop，默认口令把「暂停/pause」并入 stop，于是用户说
// 「暂停」会走 pm.stop()（清空播放上下文），而不是 pm.pause()（保留位置可恢复）。
// 本文件锁住分离后的默认口令契约。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { getDefaultVoiceCommands } from './defaults.ts';

/** 取某类型的全部关键词。 */
function keywordsOf(type: string): string[] {
  return getDefaultVoiceCommands()
    .filter((cmd) => cmd.type === type)
    .flatMap((cmd) => cmd.keywords);
}

test('默认口令包含独立的 pause 动作', () => {
  const types = getDefaultVoiceCommands().map((cmd) => cmd.type);
  assert.ok(types.includes('pause'), '默认口令必须有 pause 类型');
});

test('暂停类关键词归 pause，停止类归 stop', () => {
  const pause = keywordsOf('pause');
  const stop = keywordsOf('stop');

  for (const keyword of ['暂停播放', '暂停音乐', '暂停', 'pause']) {
    assert.ok(pause.includes(keyword), `"${keyword}" 应归 pause`);
    assert.ok(!stop.includes(keyword), `"${keyword}" 不应同时出现在 stop`);
  }

  for (const keyword of ['停止播放', '停止', 'stop']) {
    assert.ok(stop.includes(keyword), `"${keyword}" 应归 stop`);
    assert.ok(!pause.includes(keyword), `"${keyword}" 不应同时出现在 pause`);
  }
});

test('pause 与 stop 的关键词集合互不重叠', () => {
  // 重叠会让匹配结果依赖遍历顺序，同一句话可能在两种行为间摇摆。
  const overlap = keywordsOf('pause').filter((k) => keywordsOf('stop').includes(k));
  assert.deepEqual(overlap, [], `关键词重叠：${overlap.join('、')}`);
});

test('暂停类关键词默认启用', () => {
  const pauseCmds = getDefaultVoiceCommands().filter((cmd) => cmd.type === 'pause');
  assert.ok(pauseCmds.length > 0);
  assert.ok(pauseCmds.every((cmd) => cmd.enabled), 'pause 口令默认应启用');
});