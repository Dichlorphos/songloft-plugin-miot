// needUsePlayMusicAPI 的纯函数测试。
//
// 验收条目 H1/H3 的行为判据：默认清单内的型号（如 X08E）可在设置里取消勾选，
// 取消后播放改走 player_play_url；不在默认清单内的型号始终不走 Music API，
// 且不受开关影响（勾选框置灰）。
//
// 期望值取自规格与用户可见的开关语义，不拼接实现内部的常量数组，
// 避免断言与实现同源而恒真。

import test from 'node:test';
import * as assert from 'node:assert/strict';

import { needUsePlayMusicAPI } from './constants.ts';

test('默认清单内的触屏型号走 Music API', () => {
  assert.equal(needUsePlayMusicAPI('X08E'), true);
});

test('显式禁用后该型号改走直链', () => {
  assert.equal(needUsePlayMusicAPI('X08E', ['X08E']), false);
});

test('禁用清单只影响列出的型号', () => {
  assert.equal(needUsePlayMusicAPI('X08C', ['X08E']), true);
});

test('不在默认清单内的型号始终不走 Music API', () => {
  assert.equal(needUsePlayMusicAPI('NOT_A_REAL_MODEL'), false);
  // 即使被误列入禁用清单，也不得反转成走 Music API
  assert.equal(needUsePlayMusicAPI('NOT_A_REAL_MODEL', ['NOT_A_REAL_MODEL']), false);
});

test('空型号不走 Music API', () => {
  assert.equal(needUsePlayMusicAPI(''), false);
});

test('禁用清单为空或缺省时回落到默认行为', () => {
  assert.equal(needUsePlayMusicAPI('X08E', []), true);
  assert.equal(needUsePlayMusicAPI('X08E', undefined), true);
});