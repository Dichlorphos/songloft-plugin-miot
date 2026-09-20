// #466（I1–I6）在 PlaylistManager 里的接线断言。
//
// 动作判定已由 landing_failure.test.ts 在纯函数接缝处覆盖；本文件钉住 manager 确实
// 把判定接进了真实副作用路径，避免「纯函数对了但没人调用」。
//
// 这些断言原先混在 snapshot_exitpoint.test.ts 里，但那份文件只该因「快照出口」变化
// 而变化，与本主题无关，故拆出。

import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const manager = read('./manager.ts');
test('起播确认失败会标记不可播放并上报后端', () => {
  assert.match(
    manager,
    /unplayableSongIds\.add\(songIdAtLanding\)/,
    '起播确认失败必须标记该歌不可播放',
  );
  assert.match(
    manager,
    /event=landing_failed/,
    '起播失败必须上报后端',
  );
});

test('I4：自动切歌时直接跳过已标记不可播放的歌', () => {
  // 不能占用 10+8 秒起播确认窗口，必须在选曲阶段就跳过。
  assert.match(
    manager,
    /while \(nextIdx >= 0 && this\.unplayableSongIds\.has\(this\.songs\[nextIdx\]\?\.id \?\? 0\)\)/,
    'advanceToNext 必须在选曲阶段跳过已知不可播放的歌',
  );
});

test('I4：预取成功会清掉此前的不可播放标记', () => {
  // 临时抖动导致的失败不应让这首歌整个会话都不再播放。
  assert.match(
    manager,
    /unplayableSongIds\.delete\(nextSong\.id\)/,
    '预取成功必须清除不可播放标记',
  );
});

test('I5：外部停止的早期位置判定复用同一函数', () => {
  assert.match(manager, /isEarlyLandingStop\(position\)/, '外部停止路径必须复用早期判定函数');
  assert.doesNotMatch(
    manager,
    /position >= 0 && position < LANDING_EARLY_STOP_SEC/,
    '不得再内联一份位置窗口判定，避免阈值漂移',
  );
});

test('起播失败的动作判定复用纯函数，不再内联阈值比较', () => {
  assert.match(manager, /decideLandingFailure\(\{/, 'handleLandingFailure 必须调用纯函数');
});