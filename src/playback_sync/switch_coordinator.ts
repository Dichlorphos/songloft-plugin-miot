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
import { SAMPLE_TIMEOUT_MS } from './recorder.ts';

/** 设备选择结果。切换接口本身始终成功，后台同步失败只记录日志。 */
export interface SwitchResult {
  success: boolean;
  synced: boolean;
  reason?: 'no_source' | 'same_device' | 'cross_account' | 'group' | 'no_snapshot' | 'sampled' | 'storage_error';
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
  /** 采样源设备物理位置；null 表示失败。 */
  samplePosition: (accountId: string, deviceId: string) => Promise<number | null>;
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
  private readonly samplePosition: SwitchCoordinatorDeps['samplePosition'];
  private readonly loadSong: SwitchCoordinatorDeps['loadSong'];
  private readonly playPlaylist: SwitchCoordinatorDeps['playPlaylist'];
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  // 每「账号:目标设备」最多一个未完成的切换同步任务；继续操作先等它落定。
  private readonly inFlight = new Map<string, Promise<unknown>>();
  // 每个账号一条选择写入队列：把「读当前选择 → 写当前选择」串起来，
  // 否则快速连续切换时后发请求可能读到尚未落盘的旧值，或先发的慢写入反过来覆盖新选择。
  private readonly selectionQueues = new Map<string, Promise<unknown>>();


  constructor(deps: SwitchCoordinatorDeps) {
    this.snapshotStore = deps.snapshotStore;
    this.pendingStore = deps.pendingStore;
    this.getCurrentDevice = deps.getCurrentDevice;
    this.setCurrentDevice = deps.setCurrentDevice;
    this.isGroupDevice = deps.isGroupDevice;
    this.samplePosition = deps.samplePosition;
    this.loadSong = deps.loadSong;
    this.playPlaylist = deps.playPlaylist;
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * 设备选择入口。读取源设备 → 采样 → 更新当前选择 → 写 pending。
   *
   * 从不抛出：切换本身必须始终成功返回，同步失败只记日志。源设备与目标相同、
   * 跨账号、无源设备或任一侧为设备组时不创建同步任务。
   */
  async onDeviceSelected(accountId: string, targetDeviceId: string): Promise<SwitchResult> {
    const task = this.runDeviceSelected(accountId, targetDeviceId);
    this.trackInFlight(accountId, targetDeviceId, task);
    try {
      return await task;
    } catch (e) {
      this.log(`[SwitchCoordinator] device selection sync failed: ${String(e)}`);
      return { success: true, synced: false, reason: 'storage_error' };
    }
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

  private async runDeviceSelected(accountId: string, targetDeviceId: string): Promise<SwitchResult> {
    if (!accountId || !targetDeviceId) return { success: false, synced: false, reason: 'no_source' };

    // 读源设备与写目标选择必须原子：两者之间若被其它选择请求插入，
    // 既可能读到尚未落盘的旧值，也可能让先发的慢写入覆盖后来的新选择。
    const sourceDeviceId = await this.enqueueSelection(accountId, async () => {
      let source: string | null = null;
      try {
        source = await this.getCurrentDevice(accountId);
      } catch (e) {
        this.log(`[SwitchCoordinator] read current device failed: ${String(e)}`);
      }

      try {
        await this.setCurrentDevice(accountId, targetDeviceId);
      } catch (e) {
        this.log(`[SwitchCoordinator] update current device failed: ${String(e)}`);
      }
      return source;
    });
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
    const canSample = snapshot.state === 'playing';
    try {
      const position = canSample ? await this.sampleWithTimeout(accountId, sourceDeviceId) : null;
      if (position !== null && Number.isFinite(position)) {
        const result = await this.snapshotStore.write({
          ...snapshot,
          position_sec: Math.max(0, position),
          position_available: true,
          updated_at: this.now(),
          base_revision: snapshot.revision,
        });
        if (result.ok && result.snapshot) {
          sampled = result.snapshot;
        } else {
          this.log(`[SwitchCoordinator] snapshot sample write skipped reason=${result.reason ?? 'unknown'}`);
        }
      }
    } catch (e) {
      this.log(`[SwitchCoordinator] sample position failed: ${String(e)}`);
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

  /** 采样物理位置，超过 2 秒视为失败（规范「源设备位置采样超过 2 秒视为失败」）。 */
  private async sampleWithTimeout(accountId: string, deviceId: string): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SAMPLE_TIMEOUT_MS);
      });
      return await Promise.race([this.samplePosition(accountId, deviceId), timeout]);
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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

  /** 选择新内容时清除 pending，使未完成的同步任务失效。 */
  async clearPending(accountId: string, targetDeviceId: string): Promise<void> {
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
