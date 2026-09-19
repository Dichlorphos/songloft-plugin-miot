// 播放快照的宿主装配：把 songloft.storage 适配成存储接口，并提供全局单例。
//
// 纯逻辑（snapshot_store / recorder / observation / pending_store / switch_coordinator）
// 不直接依赖宿主，宿主接线只在这里。

import { PlaybackSnapshotStore, type PlaybackSnapshotStorage } from './snapshot_store.ts';
import { PlaybackRecorder } from './recorder.ts';
import { PendingContextStore, type PendingContextStorage } from './pending_store.ts';
import { SwitchCoordinator } from './switch_coordinator.ts';

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

/** 待播放上下文与快照使用同一个宿主存储，但键空间不同。 */
export function createHostPendingStorage(): PendingContextStorage {
  return createHostSnapshotStorage();
}

let snapshotStore: PlaybackSnapshotStore | null = null;
let recorder: PlaybackRecorder | null = null;

/** 取得（首次调用时创建）全局快照存储。 */
export function getSnapshotStore(): PlaybackSnapshotStore {
  if (!snapshotStore) snapshotStore = new PlaybackSnapshotStore(createHostSnapshotStorage());
  return snapshotStore;
}

/** 取得（首次调用时创建）全局快照采集器。 */
export function getPlaybackRecorder(): PlaybackRecorder {
  if (!recorder) {
    recorder = new PlaybackRecorder(getSnapshotStore(), {
      log: (message) => songloft.log.warn(message),
    });
  }
  return recorder;
}

let pendingStore: PendingContextStore | null = null;

/** 取得（首次调用时创建）全局待播放上下文存储。 */
export function getPendingContextStore(): PendingContextStore {
  if (!pendingStore) {
    pendingStore = new PendingContextStore(createHostPendingStorage());
  }
  return pendingStore;
}

/** 仅供测试重置单例。 */
export function resetPlaybackRecorderForTest(): void {
  recorder = null;
  pendingStore = null;
  snapshotStore = null;
}

let switchCoordinator: SwitchCoordinator | null = null;

/** 注入宿主装配好的切换编排器；handler 从这里读取，避免 main 与 handler 的循环依赖。 */
export function setSwitchCoordinator(coordinator: SwitchCoordinator | null): void {
  switchCoordinator = coordinator;
}

/** 取得切换编排器；未初始化时返回 null。 */
export function getSwitchCoordinator(): SwitchCoordinator | null {
  return switchCoordinator;
}

/** 仅供测试重置单例。 */
export function resetSwitchCoordinatorForTest(): void {
  switchCoordinator = null;
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
export {
  PendingContextStore,
  PENDING_CONTEXT_STORAGE_KEY,
  PENDING_CONTEXT_SCHEMA_VERSION,
  PENDING_CONTEXT_TTL_MS,
} from './pending_store.ts';
export type {
  PendingContext,
  PendingContextWrite,
  PendingContextWriteResult,
  PendingContextStorage,
} from './pending_store.ts';
export { SwitchCoordinator } from './switch_coordinator.ts';
export type { SwitchResult, ResumePendingResult, LoadedSong, SwitchCoordinatorDeps } from './switch_coordinator.ts';
