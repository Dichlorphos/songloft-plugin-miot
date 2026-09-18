import test from 'node:test';
import assert from 'node:assert/strict';

import { buildObservation, type ManagerExitState } from './observation.ts';

function exitState(overrides: Partial<ManagerExitState> = {}): ManagerExitState {
  return {
    account_id: 'acc1',
    device_id: 'dev1',
    playlist_id: 7,
    song_id: 101,
    song_index: 2,
    song_type: 'local',
    state: 'playing',
    local_position: 30,
    paused_position: 0,
    stop_position: 0,
    position_available: true,
    speed: 1,
    play_mode: 'order',
    target_count: 1,
    title: '歌名',
    artist: '歌手',
    ...overrides,
  };
}

test('playing 出口取本地播放位置', () => {
  const observation = buildObservation(exitState({ state: 'playing', local_position: 30, paused_position: 99 }));

  assert.equal(observation?.state, 'playing');
  assert.equal(observation?.position_sec, 30);
});

test('paused 出口取暂停位置而非本地推算位置', () => {
  const observation = buildObservation(exitState({ state: 'paused', local_position: 0, paused_position: 61 }));

  assert.equal(observation?.state, 'paused');
  assert.equal(observation?.position_sec, 61);
});

test('stopped 出口取停止前位置', () => {
  const observation = buildObservation(exitState({ state: 'stopped', local_position: 0, stop_position: 77 }));

  assert.equal(observation?.state, 'stopped');
  assert.equal(observation?.position_sec, 77);
});

test('radio 出口标记为 radio 内容类型', () => {
  // 位置归零、playlist_id 置空是范围策略，由 recorder 施加；观测层只忠实映射出口状态。
  const observation = buildObservation(exitState({ song_type: 'radio', playlist_id: null }));

  assert.equal(observation?.content_type, 'radio');
  assert.equal(observation?.playlist_id, null);
});

test('local/remote 出口为 playlist 内容类型', () => {
  assert.equal(buildObservation(exitState({ song_type: 'local' }))?.content_type, 'playlist');
  assert.equal(buildObservation(exitState({ song_type: 'remote' }))?.content_type, 'playlist');
});

test('位置不可用时保持 position_available=false', () => {
  const observation = buildObservation(exitState({ position_available: false, local_position: 0 }));

  assert.equal(observation?.position_available, false);
});

test('设备组出口仍上报 target_count 交由采集层判定范围', () => {
  const observation = buildObservation(exitState({ target_count: 3 }));

  assert.equal(observation?.target_count, 3);
});

test('来源设备由账号与设备构成', () => {
  const observation = buildObservation(exitState({ account_id: 'acc9', device_id: 'dev9' }));

  assert.deepEqual(observation?.source_device, { account_id: 'acc9', device_id: 'dev9' });
});

test('负位置被夹到 0', () => {
  const observation = buildObservation(exitState({ local_position: -5 }));

  assert.equal(observation?.position_sec, 0);
});

test('无效歌曲身份返回 null', () => {
  assert.equal(buildObservation(exitState({ song_id: 0 })), null);
});