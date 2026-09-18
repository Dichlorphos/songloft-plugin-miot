import test from 'node:test';
import assert from 'node:assert/strict';

import { PlaybackSnapshotStore, type PlaybackSnapshotStorage } from './snapshot_store.ts';
import { PlaybackRecorder, type PlaybackObservation } from './recorder.ts';

function memoryStorage(): PlaybackSnapshotStorage {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

function observation(overrides: Partial<PlaybackObservation> = {}): PlaybackObservation {
  return {
    account_id: 'acc1',
    content_type: 'playlist',
    song_id: 101,
    playlist_id: 7,
    song_index: 2,
    position_sec: 30,
    position_available: true,
    speed: 1,
    play_mode: 'order',
    state: 'playing',
    source_device: { account_id: 'acc1', device_id: 'dev1' },
    target_count: 1,
    title: '歌名',
    artist: '歌手',
    ...overrides,
  };
}

function makeRecorder(storage = memoryStorage(), now = () => 1_000) {
  const store = new PlaybackSnapshotStore(storage);
  return { recorder: new PlaybackRecorder(store, { now }), store };
}

test('正式歌单的独立设备播放被记录', async () => {
  const { recorder, store } = makeRecorder();

  await recorder.record(observation());

  const snapshot = await store.read('acc1');
  assert.equal(snapshot?.song_id, 101);
  assert.equal(snapshot?.playlist_id, 7);
  assert.equal(snapshot?.content_type, 'playlist');
  assert.equal(snapshot?.revision, 1);
});

test('临时歌单不记录', async () => {
  const { recorder, store } = makeRecorder();

  await recorder.record(observation({ playlist_id: -1, content_type: 'playlist' }));

  assert.equal(await store.read('acc1'), null);
});

test('设备组播放不记录', async () => {
  const { recorder, store } = makeRecorder();

  await recorder.record(observation({ target_count: 2 }));

  assert.equal(await store.read('acc1'), null);
});

test('电台记录为 radio 且 playlist_id 为 null、位置固定 0', async () => {
  const { recorder, store } = makeRecorder();

  await recorder.record(observation({
    content_type: 'radio',
    playlist_id: null,
    song_id: 555,
    position_sec: 42,
  }));

  const snapshot = await store.read('acc1');
  assert.equal(snapshot?.content_type, 'radio');
  assert.equal(snapshot?.playlist_id, null);
  assert.equal(snapshot?.song_id, 555);
  assert.equal(snapshot?.position_sec, 0);
});

test('暂停记录暂停位置与 paused 状态', async () => {
  const { recorder, store } = makeRecorder();

  await recorder.record(observation({ state: 'paused', position_sec: 61 }));

  const snapshot = await store.read('acc1');
  assert.equal(snapshot?.state, 'paused');
  assert.equal(snapshot?.position_sec, 61);
});

test('停止记录 stopped 状态并保留停止前位置', async () => {
  const { recorder, store } = makeRecorder();

  await recorder.record(observation({ state: 'stopped', position_sec: 77 }));

  const snapshot = await store.read('acc1');
  assert.equal(snapshot?.state, 'stopped');
  assert.equal(snapshot?.position_sec, 77);
});

test('首次播放拿不到位置时仍记录并把 position_available 置为 false', async () => {
  const { recorder, store } = makeRecorder();

  await recorder.record(observation({ position_available: false, position_sec: 0 }));

  const snapshot = await store.read('acc1');
  assert.equal(snapshot?.position_available, false);
  assert.equal(snapshot?.position_sec, 0);
});

test('存储失败不影响调用方，不抛出', async () => {
  const storage: PlaybackSnapshotStorage = {
    async get() {
      return null;
    },
    async set() {
      throw new Error('quota exceeded');
    },
  };
  const { recorder } = makeRecorder(storage);

  await assert.doesNotReject(() => recorder.record(observation()));
});

test('切换采样成功时用采样位置创建新 revision', async () => {
  const { recorder, store } = makeRecorder();
  await recorder.record(observation({ position_sec: 10 }));
  const before = await store.read('acc1');

  const result = await recorder.sampleOnSwitch({
    account_id: 'acc1',
    device_id: 'dev1',
    samplePosition: async () => 88,
  });

  const after = await store.read('acc1');
  assert.equal(result.ok, true);
  assert.equal(after?.position_sec, 88);
  assert.equal(after?.position_available, true);
  assert.equal(after?.revision, (before?.revision ?? 0) + 1);
});

test('切换采样失败时保留旧快照且不产生新 revision', async () => {
  const { recorder, store } = makeRecorder();
  await recorder.record(observation({ position_sec: 10 }));
  const before = await store.read('acc1');

  const result = await recorder.sampleOnSwitch({
    account_id: 'acc1',
    device_id: 'dev1',
    samplePosition: async () => null,
  });

  const after = await store.read('acc1');
  assert.equal(result.ok, false);
  assert.equal(after?.position_sec, 10);
  assert.equal(after?.revision, before?.revision);
});

test('切换采样超时（超过 2 秒）视为失败', async () => {
  const { recorder, store } = makeRecorder();
  await recorder.record(observation({ position_sec: 10 }));
  const before = await store.read('acc1');

  const result = await recorder.sampleOnSwitch({
    account_id: 'acc1',
    device_id: 'dev1',
    samplePosition: () => new Promise((resolve) => setTimeout(() => resolve(50), 20)),
    timeoutMs: 5,
  });

  assert.equal(result.ok, false);
  assert.equal((await store.read('acc1'))?.revision, before?.revision);
});

test('尚无快照时切换采样失败不创建快照', async () => {
  const { recorder, store } = makeRecorder();

  const result = await recorder.sampleOnSwitch({
    account_id: 'acc1',
    device_id: 'dev1',
    samplePosition: async () => null,
  });

  assert.equal(result.ok, false);
  assert.equal(await store.read('acc1'), null);
});
test('删除账号后快照与 revision 一并清除', async () => {
  const { recorder, store } = makeRecorder();
  await recorder.record(observation());
  assert.equal((await store.read('acc1'))?.revision, 1);

  await recorder.forgetAccount('acc1');

  assert.equal(await store.read('acc1'), null);
  await recorder.record(observation());
  assert.equal((await store.read('acc1'))?.revision, 1);
});

test('删除账号不影响其它账号', async () => {
  const { recorder, store } = makeRecorder();
  await recorder.record(observation({ account_id: 'keep' }));

  await recorder.forgetAccount('gone');

  assert.equal((await store.read('keep'))?.revision, 1);
});