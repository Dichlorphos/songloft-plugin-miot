// 快照出口接线必须完整：PlaylistManager 的每个状态机出口都要上报观测。
//
// 这条是防回归用的。ADR-0002 把「快照只在状态机出口记录」当作架构基石：出口天然覆盖
// 网页、语音、定时任务与内部自动停止，而入口清单会随功能增加漂移。但「出口本身有没有
// 漏掉 captureSnapshot」没有任何运行时兜底——漏一个就静默少记一类播放。
//
// observation.test.ts 覆盖的是「给定出口该报什么」（纯函数），本文件覆盖的是
// 「代码里确实存在这些出口调用」（接线）。两者互补，缺一不可。

import test from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const manager = read('../player/manager.ts');

test('六个状态机出口都调用 captureSnapshot', () => {
  // 计入三元与门控形式（pause 按 hardStopped 分支、stop 按 pushToDevice 门控），
  // 因此匹配调用前缀而非字面量实参。
  const calls = manager.match(/await this\.captureSnapshot\(/g) ?? [];
  assert.equal(calls.length, 6, `期望 6 处出口上报，实际 ${calls.length} 处`);
});

test('暂停出口按实际结果区分 paused 与 stopped', () => {
  // 部分机型会把 pause 升级为硬停，此时必须写 stopped 而不是 paused。
  assert.match(
    manager,
    /await this\.captureSnapshot\(this\.hardStopped \? 'stopped' : 'paused'\)/,
    'pause() 出口必须按 hardStopped 区分状态',
  );
});

test('主动停止才写快照，外部探测路径不写', () => {
  // stop(pushToDevice=false) 是「设备自己停了」的外部路径，写快照会把用户可恢复的
  // 上下文覆盖成 stopped。
  assert.match(
    manager,
    /if \(pushToDevice\) await this\.captureSnapshot\('stopped'\)/,
    'stop() 出口必须由 pushToDevice 门控',
  );
});

test('起播成功与续播成功都上报 playing', () => {
  // playCurrent（起播）与 resumePlayback（续播）是两个不同出口，都不能漏。
  const playing = manager.match(/await this\.captureSnapshot\('playing'\)/g) ?? [];
  assert.equal(playing.length, 2, `期望起播与续播两处 playing 出口，实际 ${playing.length} 处`);
});

test('自动切歌的单曲结束与歌单播完出口都在', () => {
  assert.match(manager, /状态机出口：单曲播放结束。\s*\n\s*await this\.captureSnapshot\('paused'\)/);
  assert.match(manager, /状态机出口：歌单播完。\s*\n\s*await this\.captureSnapshot\('stopped'\)/);
});

test('自动切歌失败刻意不写快照（保留上一条有效快照）', () => {
  // 规范第 71 行：自动切歌失败保留上一条有效快照。
  // 用「失败收尾段落里不得出现 captureSnapshot」来钉住这条。
  const idx = manager.indexOf('Auto-next failed after retry, stopping');
  assert.ok(idx > 0, '未找到自动切歌失败收尾段落');
  const tail = manager.slice(idx, idx + 1200);
  assert.doesNotMatch(
    tail,
    /captureSnapshot/,
    '自动切歌失败不得写快照，否则会覆盖上一条可恢复的上下文',
  );
});

test('生产接线把 recorder 注入给 PlaylistManagerMap', () => {
  const main = read('../main.ts');
  assert.match(
    main,
    /playlistManagerMap\.setSnapshotRecorder\(getPlaybackRecorder\(\)\)/,
    'main 必须把全局 recorder 注入管理器，否则出口上报无处可去',
  );
});
