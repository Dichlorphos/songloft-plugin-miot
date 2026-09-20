// 旧默认口令的一次性迁移（规格第 62 行 pause/stop 分离的配套）。
//
// 背景：早期默认口令把「暂停/pause」并入了 stop。用户一旦在设置页保存过口令，
// 配置就被固化在存储里，getVoiceCommands 只在存储为空时才回退默认——于是这些用户
// 永远拿不到拆出来的 pause 动作，「暂停播放」会一直走 stop（清空播放上下文）。
//
// 迁移必须保守：只替换「仍等于旧默认 stop 项」的配置，用户改过的口令一律不动。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { migrateLegacyStopCommand, LEGACY_STOP_KEYWORDS } from './defaults.ts';

/** 早期版本的默认口令（含合并的 stop 项）。 */
function legacyCommands() {
  return [
    { type: 'next', keywords: ['下一首'], enabled: true },
    {
      type: 'stop',
      keywords: [...LEGACY_STOP_KEYWORDS],
      enabled: true,
    },
  ];
}

test('旧默认 stop 项被拆成 pause 与 stop', () => {
  const migrated = migrateLegacyStopCommand(legacyCommands());

  assert.ok(migrated, '应当发生迁移');
  const pause = migrated!.filter((c) => c.type === 'pause');
  const stop = migrated!.filter((c) => c.type === 'stop');
  assert.equal(pause.length, 1, '应插入一条 pause');
  assert.equal(stop.length, 1, '应保留一条 stop');
  assert.ok(pause[0].keywords.includes('暂停播放'));
  assert.ok(!stop[0].keywords.includes('暂停播放'), 'stop 不应再包含暂停类关键词');
});

test('迁移保留其它口令与顺序', () => {
  const migrated = migrateLegacyStopCommand(legacyCommands())!;

  assert.equal(migrated[0].type, 'next');
  assert.deepEqual(migrated[0].keywords, ['下一首']);
});

test('用户自定义的 stop 口令不动', () => {
  const custom = [
    { type: 'stop', keywords: ['我的停止口令'], enabled: true },
  ];
  assert.equal(migrateLegacyStopCommand(custom), null, '自定义口令不得被改写');
});

test('已经拆过的配置不再迁移（幂等）', () => {
  const already = [
    { type: 'pause', keywords: ['暂停播放'], enabled: true },
    { type: 'stop', keywords: ['停止播放'], enabled: true },
  ];
  assert.equal(migrateLegacyStopCommand(already), null, '已含 pause 时不应再迁移');
});

test('没有 stop 项的配置不动', () => {
  assert.equal(migrateLegacyStopCommand([{ type: 'next', keywords: ['下一首'], enabled: true }]), null);
});