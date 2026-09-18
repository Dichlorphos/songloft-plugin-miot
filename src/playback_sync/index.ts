// 播放快照的宿主装配：把 songloft.storage 适配成存储接口，并提供全局单例。
//
// 纯逻辑（snapshot_store / recorder / observation）不直接依赖宿主，宿主接线只在这里。

import { PlaybackSnapshotStore, type PlaybackSnapshotStorage } from './snapshot_store.ts';
import { PlaybackRecorder } from './recorder.ts';

/** 用宿主 storage 实现快照存储接口；读写失败由上层按无数据/失败处理。 */
export function createHostSnapshotStorage(): PlaybackSnapshotStorage {
  return {
    async get(key) {
      const raw = await songloft.storage.get(key);
      return raw === null || raw === undefined || raw === '' ? null : String(raw);
    },
    async set(key, value) {
      await songloft.storage.set(key, value);
    },
  };
}

let recorder: PlaybackRecorder | null = null;

/** 取得（首次调用时创建）全局快照采集器。 */
export function getPlaybackRecorder(): PlaybackRecorder {
  if (!recorder) {
    recorder = new PlaybackRecorder(new PlaybackSnapshotStore(createHostSnapshotStorage()), {
      log: (message) => songloft.log.warn(message),
    });
  }
  return recorder;
}

/** 仅供测试重置单例。 */
export function resetPlaybackRecorderForTest(): void {
  recorder = null;
}

export {
  PlaybackSnapshotStore,
  PLAYBACK_SNAPSHOT_STORAGE_KEY,
  PLAYBACK_SNAPSHOT_TTL_MS,
} from './snapshot_store.ts';
export type {
  PlaybackSnapshot,
  NewPlaybackSnapshot,
  PlaybackSnapshotStorage,
  PlaybackContentType,
  PlaybackSnapshotState,
} from './snapshot_store.ts';
export { PlaybackRecorder, SAMPLE_TIMEOUT_MS } from './recorder.ts';
export type { PlaybackObservation, SwitchSampleRequest, SwitchSampleResult } from './recorder.ts';
export { buildObservation } from './observation.ts';
export type { ManagerExitState } from './observation.ts';