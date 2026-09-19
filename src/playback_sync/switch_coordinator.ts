// 切换编排：把设备选择、继续播放与新内容清除三条路径的规则收口。
//
// 纯逻辑层只依赖注入的最小能力，不直接触碰宿主对象；宿主 API、存储与播放管理器的
// 适配放在 index.ts。这样切换规则可以用内存 fake 直接驱动测试。
//
// 关键顺序（规范「设备切换与待播放上下文」）：
//   1. 源设备 = 请求开始时的当前选择（必须在更新当前选择之前读），否则永远得到目标设备；
//   2. 先采样源设备物理位置刷新快照，再写 pending；采样失败保留旧位置但仍可入队；
//   3. 切换本身不向设备下发任何控制命令。
//
// 跨账号切换、源与目标相同、设备组都不同步，只更新当前选择。

import { PendingContextStore, type PendingContext } from './pending_store.ts';
import { PlaybackSnapshotStore, type PlaybackSnapshot } from './snapshot_store.ts';
import type { SwitchSampleResult } from './recorder.ts';

/** 设备选择结果。切换接口本身始终成功，后台同步失败只记录日志。 */
export interface SwitchResult {
  success: boolean;
  synced: boolean;
  reason?: 'no_source' | 'same_device' | 'cross_account' | 'group' | 'no_snapshot' | 'sampled' | 'storage_error';
}

/** 设备选择提交结果；选择写入成功即 true，完整同步任务由 sync 表示。 */
export interface DeviceSelectionResult {
  success: boolean;
  /** 选择提交成功后启动的采样与 pending 写入任务；失败或无需同步时为 null。 */
  sync: Promise<SwitchResult> | null;
}

/** 继续播放结果。`none` 表示没有可用的待播放上下文，调用方应回退目标原活动上下文。 */
export interface ResumePendingResult {
  outcome: 'succeeded' | 'failed' | 'unknown' | 'none';
}

/** 恢复时从宿主取回的歌曲对象；只依赖播放所需字段。 */
export interface LoadedSong {
  id: number;
  type: string;
  title: string;
  artist: string;
  duration: number;
  url: string;
  [key: string]: unknown;
}

export interface SwitchCoordinatorDeps {
  snapshotStore: PlaybackSnapshotStore;
  pendingStore: PendingContextStore;
  /** 读取请求开始时的当前选中设备；null 表示没有旧设备。 */
  getCurrentDevice: (accountId: string) => Promise<string | null>;
  /** 更新当前选中设备。 */
  setCurrentDevice: (accountId: string, deviceId: string) => Promise<void>;
  /** 目标或源是否为设备组成员；组成员完全跳过同步。 */
  isGroupDevice: (accountId: string, deviceId: string) => Promise<boolean>;
  /**
   * 切换时刷新源设备快照。这里注入任务 01 暴露的采样入口（PlaybackRecorder.sampleOnSwitch），
   * 采样、2 秒超时与 revision 写入都归它，避免同一规则在本层再实现一遍而漂移。
   */
  sampleOnSwitch: (accountId: string, deviceId: string) => Promise<SwitchSampleResult>;
  /** 按 song_id 取回同一播放服务的歌曲对象；取不到返回 null。 */
  loadSong: (songId: number) => Promise<LoadedSong | null>;
  /**
   * 下发 pending 上下文。返回 true 表示确认起播成功。
   * song 为命中的原 ID 歌曲；fallback 到其它歌曲时 positionSec 已规整为 0。
   */
  playPlaylist: (
    accountId: string,
    targetDeviceId: string,
    playlistId: number,
    song: LoadedSong,
    songIndex: number,
    positionSec: number,
    mode: string,
    speed: number,
  ) => Promise<'succeeded' | 'failed' | 'unknown'>;
  log?: (message: string) => void;
  now?: () => number;
}

/** 设备选择时的切换编排器。 */
export class SwitchCoordinator {
  private readonly snapshotStore: PlaybackSnapshotStore;
  private readonly pendingStore: PendingContextStore;
  private readonly getCurrentDevice: SwitchCoordinatorDeps['getCurrentDevice'];
  private readonly setCurrentDevice: SwitchCoordinatorDeps['setCurrentDevice'];
  private readonly isGroupDevice: SwitchCoordinatorDeps['isGroupDevice'];
  private readonly sampleOnSwitch: SwitchCoordinatorDeps['sampleOnSwitch'];
  private readonly loadSong: SwitchCoordinatorDeps['loadSong'];
  private readonly playPlaylist: SwitchCoordinatorDeps['playPlaylist'];
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  // 每「账号:目标设备」最多一个未完成的切换同步任务；继续操作先等它落定。
  private readonly inFlight = new Map<string, Promise<unknown>>();
  // 每个账号一条选择写入队列：把「读当前选择 → 写当前选择」串起来，
  // 否则快速连续切换时后发请求可能读到尚未落盘的旧值，或先发的慢写入反过来覆盖新选择。
  private readonly selectionQueues = new Map<string, Promise<unknown>>();
  // 每个「账号:目标设备」一个同步任务代际；clearPending 递增使旧任务不能回写。
  private readonly contentGenerations = new Map<string, number>();


  constructor(deps: SwitchCoordinatorDeps) {
    this.snapshotStore = deps.snapshotStore;
    this.pendingStore = deps.pendingStore;
    this.getCurrentDevice = deps.getCurrentDevice;
    this.setCurrentDevice = deps.setCurrentDevice;
    this.isGroupDevice = deps.isGroupDevice;
    this.sampleOnSwitch = deps.sampleOnSwitch;
    this.loadSong = deps.loadSong;
    this.playPlaylist = deps.playPlaylist;
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * 设备选择入口的同步提交阶段：读取源设备并更新当前选择，然后启动后台同步。
   *
   * 该 Promise 只等到「当前选择」成功写入后 resolve；采样与写 pending 仍在后台执行，
   * 由 `tryResumePending` 等待。这样接口返回后读取设备状态不会看到旧选择。
   */
  async beginDeviceSelection(accountId: string, targetDeviceId: string): Promise<DeviceSelectionResult> {
    if (!accountId || !targetDeviceId) return { success: false, sync: null };

    let sourceDeviceId: string | null = null;
    try {
      // 读源设备与写目标选择必须原子：两者之间若被其它选择请求插入，
      // 既可能读到尚未落盘的旧值，也可能让先发的慢写入覆盖后来的新选择。
      sourceDeviceId = await this.enqueueSelection(accountId, async () => {
        let source: string | null = null;
        try {
          source = await this.getCurrentDevice(accountId);
        } catch (e) {
          this.log(`[SwitchCoordinator] read current device failed: ${String(e)}`);
        }
        await this.setCurrentDevice(accountId, targetDeviceId);
        return source;
      });
    } catch (e) {
      this.log(`[SwitchCoordinator] update current device failed: ${String(e)}`);
      return { success: false, sync: null };
    }

    // 选择已经提交；后续同步失败不得回滚选择，也不得阻塞接口。
    const key = `${accountId}:${targetDeviceId}`;
    const generation = this.contentGenerations.get(key) ?? 0;
    const task = this.runDeviceSelected(accountId, targetDeviceId, sourceDeviceId, generation).catch((e) => {
      this.log(`[SwitchCoordinator] device selection sync failed: ${String(e)}`);
      return { success: true, synced: false, reason: 'storage_error' } as SwitchResult;
    });
    this.trackInFlight(accountId, targetDeviceId, task);
    return { success: true, sync: task };
  }

  /**
   * 完整执行一次设备选择并等待同步完成。
   *
   * HTTP 入口用 `beginDeviceSelection`，避免采样拖慢响应；此方法保留给测试与需要
   * 精确同步结果的调用方。
   */
  async onDeviceSelected(accountId: string, targetDeviceId: string): Promise<SwitchResult> {
    const selected = await this.beginDeviceSelection(accountId, targetDeviceId);
    if (!selected.success) return { success: false, synced: false, reason: 'storage_error' };
    if (!selected.sync) return { success: true, synced: false, reason: 'no_source' };
    return await selected.sync;
  }

  /** 记录未完成的切换同步任务，供同目标的继续操作等待。 */
  private trackInFlight(accountId: string, targetDeviceId: string, task: Promise<unknown>): void {
    const key = `${accountId}:${targetDeviceId}`;
    this.inFlight.set(key, task);
    void task.finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    }).catch(() => undefined);
  }

  /** 等待该目标未完成的切换同步任务；没有则立即返回。 */
  private async waitForInFlight(accountId: string, targetDeviceId: string): Promise<void> {
    const task = this.inFlight.get(`${accountId}:${targetDeviceId}`);
    if (task) await task.catch(() => undefined);
  }

  /**
   * 把一次选择提交串到该账号的队列尾部，前一个失败也照常执行下一个。
   *
   * 只包住「读当前选择 → 写当前选择」这段临界区：它是竞态的根源。采样与
   * 写 pending 放在锁外，避免慢采样拖住后续切换；它们由 revision 规则兜底。
   */
  private enqueueSelection<T>(accountId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.selectionQueues.get(accountId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const queue = next.catch(() => undefined);
    this.selectionQueues.set(accountId, queue);
    void queue.finally(() => {
      if (this.selectionQueues.get(accountId) === queue) this.selectionQueues.delete(accountId);
    }).catch(() => undefined);
    return next;
  }

  private async runDeviceSelected(
    accountId: string,
    targetDeviceId: string,
    sourceDeviceId: string | null,
    generation: number,
  ): Promise<SwitchResult> {
    if (!sourceDeviceId) return { success: true, synced: false, reason: 'no_source' };
    if (sourceDeviceId === targetDeviceId) return { success: true, synced: false, reason: 'same_device' };

    try {
      if (await this.isGroupDevice(accountId, sourceDeviceId) || await this.isGroupDevice(accountId, targetDeviceId)) {
        return { success: true, synced: false, reason: 'group' };
      }
    } catch (e) {
      this.log(`[SwitchCoordinator] group check failed: ${String(e)}`);
    }

    const snapshot = await this.snapshotStore.read(accountId);
    if (!snapshot) return { success: true, synced: false, reason: 'no_snapshot' };
    // 过期的基线不再同步：规范要求此时若采样成功可建新 revision，采样失败则保持原状。
    const expired = this.snapshotStore.isExpired(snapshot, this.now());


    let sampled: PlaybackSnapshot = snapshot;
    // 只有 playing 才在切换时采样物理位置：pause/stop 的位置已由状态机出口写好，
    // 切换时再采会把设备端可能为 0 的位置覆盖掉。
    if (snapshot.state === 'playing') {
      try {
        const result = await this.sampleOnSwitch(accountId, sourceDeviceId);
        if (result.ok && result.snapshot) {
          sampled = result.snapshot;
        } else if (!result.ok) {
          this.log(`[SwitchCoordinator] switch sample skipped reason=${result.reason ?? 'unknown'}`);
        }
      } catch (e) {
        this.log(`[SwitchCoordinator] switch sample failed: ${String(e)}`);
      }
    }

    // 过期且采样未产生新 revision 时不同步：目标保持原上下文。
    if (expired && sampled.revision === snapshot.revision) {
      return { success: true, synced: false, reason: 'no_snapshot' };
    }

    try {
      const write = await this.pendingStore.write({
        account_id: accountId,
        target_device_id: targetDeviceId,
        source_revision: sampled.revision,
        snapshot: sampled,
        now: this.now(),
        // 锁内复查代际：clearPending 与本任务并发时，旧任务不得在清除之后重新落盘。
        shouldWrite: () => (this.contentGenerations.get(`${accountId}:${targetDeviceId}`) ?? 0) === generation,
      });
      if (!write.ok) {
        this.log(`[SwitchCoordinator] pending write skipped reason=${write.reason ?? 'unknown'}`);
        return { success: true, synced: false, reason: 'storage_error' };
      }
      return { success: true, synced: true, reason: 'sampled' };
    } catch (e) {
      this.log(`[SwitchCoordinator] pending write failed: ${String(e)}`);
      return { success: true, synced: false, reason: 'storage_error' };
    }
  }



  /**
   * 继续播放时优先消费 pending。
   *
   * 只有确认起播成功才清除 pending；加载失败、下发失败与 unknown 都保留原记录。
   * 返回 `none` 表示没有有效 pending，调用方回退目标原活动上下文。
   */
  async tryResumePending(accountId: string, targetDeviceId: string): Promise<ResumePendingResult> {
    await this.waitForInFlight(accountId, targetDeviceId);
    let pending: PendingContext | null = null;
    try {
      pending = await this.pendingStore.read(accountId, targetDeviceId, this.now());
    } catch (e) {
      this.log(`[SwitchCoordinator] pending read failed: ${String(e)}`);
      return { outcome: 'none' };
    }
    if (!pending) return { outcome: 'none' };

    const snapshot = pending.snapshot;
    let song: LoadedSong | null = null;
    try {
      song = await this.loadSong(snapshot.song_id);
    } catch (e) {
      this.log(`[SwitchCoordinator] load song failed song_id=${snapshot.song_id}: ${String(e)}`);
    }
    if (!song) {
      return { outcome: 'failed' };
    }

    // 命中原 ID 才恢复位置；回退到其它歌曲必须从 0 开始（规范「歌曲恢复按 ID…」）。
    const hit = song.id === snapshot.song_id;
    const positionSec = hit && snapshot.position_available ? snapshot.position_sec : 0;
    const playlistId = snapshot.content_type === 'playlist' ? snapshot.playlist_id : null;

    try {
      if (playlistId === null || playlistId <= 0) {
        // 电台：没有歌单，按单曲上下文下发。位置固定 0。
        const outcome = await this.playPlaylist(accountId, targetDeviceId, 0, song, snapshot.song_index, 0, snapshot.play_mode, snapshot.speed);
        if (outcome === 'succeeded') {
          await this.pendingStore.clear(accountId, targetDeviceId);
        }
        return { outcome };
      }

      const outcome = await this.playPlaylist(accountId, targetDeviceId, playlistId, song, snapshot.song_index, positionSec, snapshot.play_mode, snapshot.speed);
      if (outcome === 'succeeded') {
        await this.pendingStore.clear(accountId, targetDeviceId);
      }
      return { outcome };
    } catch (e) {
      this.log(`[SwitchCoordinator] resume pending failed: ${String(e)}`);
      return { outcome: 'failed' };
    }
  }

  /** 选择新内容时清除 pending，并使旧同步任务的晚到写入失效。 */
  async clearPending(accountId: string, targetDeviceId: string): Promise<void> {
    const key = `${accountId}:${targetDeviceId}`;
    this.contentGenerations.set(key, (this.contentGenerations.get(key) ?? 0) + 1);
    try {
      await this.pendingStore.clear(accountId, targetDeviceId);
    } catch (e) {
      this.log(`[SwitchCoordinator] clear pending failed: ${String(e)}`);
    }
  }

  /** 播放请求处理处调用：先于加载与起播清除 pending。 */
  async onNewContentRequested(accountId: string, targetDeviceId: string): Promise<void> {
    await this.clearPending(accountId, targetDeviceId);
  }
}

