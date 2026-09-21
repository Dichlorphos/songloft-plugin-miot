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

import { PendingContextStore, pendingKey, type PendingContext } from './pending_store.ts';
import { PlaybackSnapshotStore, type PlaybackSnapshot } from './snapshot_store.ts';
import type { SwitchSampleResult } from './recorder.ts';
import type { LandingResult } from '../player/landing_failure.ts';

/** 设备选择结果。切换接口本身始终成功，后台同步失败只记录日志。 */
export interface SwitchResult {
  success: boolean;
  synced: boolean;
  reason?: 'no_source' | 'same_device' | 'group' | 'no_snapshot' | 'sampled' | 'storage_error';
}

/** 设备选择提交结果；选择写入成功即 true，完整同步任务由 sync 表示。 */
export interface DeviceSelectionResult {
  success: boolean;
  /** 选择提交成功后启动的采样与 pending 写入任务；失败或无需同步时为 null。 */
  sync: Promise<SwitchResult> | null;
}

/**
 * 继续播放结果。
 *
 * - `dispatched`：待播放上下文已受理并下发，正在等待起播确认（电台/单曲播放没有确认，受理即视为消费完成）；
 * - `in-progress`：同一条待播放上下文正在等待起播确认，本次重复请求不得再次下发；
 * - `failed` / `unknown`：本次消费失败或结果未知，保留待播放上下文；
 * - `none`：没有可用的待播放上下文，调用方应回退目标原活动上下文。
 */
export interface ResumePendingResult {
  outcome: 'dispatched' | 'in-progress' | 'failed' | 'unknown' | 'none';
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
   * 下发 pending 上下文。返回 `dispatched` 只表示下发已被受理，不代表设备已起播；
   * 起播确认结果通过 onLandingResult 另行结算。
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
    onLandingResult?: (result: LandingResult) => void | Promise<void>,
  ) => Promise<'dispatched' | 'failed' | 'unknown'>;
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
  // 每「账号:目标设备」一条「消费待播放上下文」队列。从读到 pending 到消费完（成功清除）
  // 之间不能让另一路插进来：否则两路并发继续会各自读到同一条 pending、各自下发一次播放
  // （用户快速连点，或网页 toggle 与语音 resume 同时到达）。后到的一路拿到 none。
  private readonly resumeQueues = new Map<string, Promise<unknown>>();
  // 每个账号一条选择写入队列：把「读当前选择 → 写当前选择」串起来，
  // 否则快速连续切换时后发请求可能读到尚未落盘的旧值，或先发的慢写入反过来覆盖新选择。
  private readonly selectionQueues = new Map<string, Promise<unknown>>();
  // 每个「账号:目标设备」一个同步任务代际；clearPending 递增使旧任务不能回写。
  private readonly contentGenerations = new Map<string, number>();
  // 每个「账号:目标设备」是否有已下发、正在等待起播确认的消费；用于拦截重复继续。
  // 用布尔标记而不是代际比较：确认成功清除 pending 会递增代际，否则登记会立刻失效、
  // 重复继续又能挤进来。
  private readonly activeResumes = new Set<string>();


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
   *
   * `fromAccountId` 是请求开始前界面上选中的账号。它只在**跨账号**时才由调用方提供：
   * 那时源设备属于另一个账号，本账号的「当前选择」与本次切换无关，因此只更新选择、
   * 不创建任何同步任务（规范：跨账号切换不把源账号快照写入目标账号）。
   */
  async beginDeviceSelection(
    accountId: string,
    targetDeviceId: string,
    fromAccountId?: string,
  ): Promise<DeviceSelectionResult> {
    // 跨账号：源设备在别的账号下，本账号无从采样，也不该给目标设备排队任何上下文。
    const crossAccount = typeof fromAccountId === 'string' && fromAccountId !== '' && fromAccountId !== accountId;
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

    // 跨账号切换到此为止：选择已提交，但没有可同步的源设备。
    if (crossAccount) return { success: true, sync: null };

    // 选择已经提交；后续同步失败不得回滚选择，也不得阻塞接口。
    // 每次新选择也递增代际：同一目标连续两次选择时，先发任务的晚到 pending 不得覆盖后发任务。
    const key = pendingKey(accountId, targetDeviceId);
    const generation = (this.contentGenerations.get(key) ?? 0) + 1;
    this.contentGenerations.set(key, generation);
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
  async onDeviceSelected(accountId: string, targetDeviceId: string, fromAccountId?: string): Promise<SwitchResult> {
    const selected = await this.beginDeviceSelection(accountId, targetDeviceId, fromAccountId);
    if (!selected.success) return { success: false, synced: false, reason: 'storage_error' };
    if (!selected.sync) return { success: true, synced: false, reason: 'no_source' };
    return await selected.sync;
  }

  /** 记录未完成的切换同步任务，供同目标的继续操作等待。 */
  private trackInFlight(accountId: string, targetDeviceId: string, task: Promise<unknown>): void {
    const key = pendingKey(accountId, targetDeviceId);
    this.inFlight.set(key, task);
    void task.finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    }).catch(() => undefined);
  }

  /** 等待该目标未完成的切换同步任务；没有则立即返回。 */
  private async waitForInFlight(accountId: string, targetDeviceId: string): Promise<void> {
    const task = this.inFlight.get(pendingKey(accountId, targetDeviceId));
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

    // 设备组必须完全跳过同步。判定本身失败时无法排除「这是设备组」，因此保守跳过：
    // 放行的代价是把组内设备当成独立设备、产生本不该有的跨设备上下文。
    try {
      if (await this.isGroupDevice(accountId, sourceDeviceId) || await this.isGroupDevice(accountId, targetDeviceId)) {
        return { success: true, synced: false, reason: 'group' };
      }
    } catch (e) {
      this.log(`[SwitchCoordinator] group check failed, skipping sync: ${String(e)}`);
      return { success: true, synced: false, reason: 'group' };
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
          // 采样窗口有 2 秒，期间源设备可能已经自动切歌/切歌单并写入更新的出口快照，
          // 使本次采样写回被判 stale。那时读取时的旧快照已经过期：继续用它会让目标设备
          // 恢复成「已经过去的那首」。改读当前快照——只有它仍来自同一台源设备时才采用，
          // 否则会把同账号另一台设备的内容张冠李戴成这个目标的待播放上下文。
          if (result.reason === 'stale') {
            sampled = await this.readFreshSnapshotForSource(accountId, sourceDeviceId) ?? sampled;
          }
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
        shouldWrite: () => (this.contentGenerations.get(pendingKey(accountId, targetDeviceId)) ?? 0) === generation,
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
   * 下发受理后返回 `dispatched` 并保留 pending，等起播确认结果再清除；加载失败、
   * 下发失败与 unknown 都保留原记录。返回 `none` 表示没有有效 pending，调用方回退目标原活动上下文。
   */
  async tryResumePending(accountId: string, targetDeviceId: string): Promise<ResumePendingResult> {
    return this.enqueueResume(accountId, targetDeviceId, () =>
      this.tryResumePendingLocked(accountId, targetDeviceId));
  }

  /**
   * 把一次「消费待播放上下文」串到该目标的消费队列尾部。
   *
   * 只在同一「账号 + 目标设备」内串行：不同目标互不影响。前一个任务失败也照常执行下一个，
   * 队列自身永不 reject，避免一次失败卡死后续继续操作。
   */
  private enqueueResume<T>(accountId: string, targetDeviceId: string, task: () => Promise<T>): Promise<T> {
    const key = pendingKey(accountId, targetDeviceId);
    const previous = this.resumeQueues.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const queue = next.catch(() => undefined);
    this.resumeQueues.set(key, queue);
    void queue.finally(() => {
      if (this.resumeQueues.get(key) === queue) this.resumeQueues.delete(key);
    }).catch(() => undefined);
    return next;
  }

  /** 消费待播放上下文的临界区实现；语义见 tryResumePending。 */
  private async tryResumePendingLocked(accountId: string, targetDeviceId: string): Promise<ResumePendingResult> {
    await this.waitForInFlight(accountId, targetDeviceId);
    let read;
    try {
      read = await this.pendingStore.readWithStatus(accountId, targetDeviceId, this.now());
    } catch (e) {
      this.log(`[SwitchCoordinator] pending read failed: ${String(e)}`);
      return { outcome: 'failed' };
    }
    // 存储读不了不等于「没有待播放上下文」：当成没有会静默回退到目标原活动上下文，
    // 播成另一个内容还报告成功。宁可如实报失败。
    if (read.status === 'error') {
      this.log(`[SwitchCoordinator] pending read error, refusing to fall back: ${read.message}`);
      return { outcome: 'failed' };
    }
    if (read.status === 'none') return { outcome: 'none' };
    const pending = read.pending;
    // 记下读取时的内容代际：消费过程中若用户选了新内容（clearPending 递增代际），
    // 手里的旧快照就作废了，不能再推下去。
    const generation = this.contentGenerations.get(pendingKey(accountId, targetDeviceId)) ?? 0;
    // 同一条 pending 正在等待起播确认时，重复「继续」不得再下发一次，只回答「恢复中」。
    const key = pendingKey(accountId, targetDeviceId);
    if (this.activeResumes.has(key)) {
      return { outcome: 'in-progress' };
    }

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

    // 代际复查（下发之前）：加载歌曲期间用户可能已经选了新内容。那时不能再把旧上下文推下去，
    // 但也不该报失败——目标的活动上下文已经被新内容替换，如实告诉调用方「没有可消费的上下文」。
    if (!this.isGenerationCurrent(accountId, targetDeviceId, generation)) {
      this.log('[SwitchCoordinator] pending superseded by new content, skipping resume');
      return { outcome: 'none' };
    }

    // 命中原 ID 才恢复位置；回退到其它歌曲必须从 0 开始（规范「歌曲恢复按 ID…」）。
    const hit = song.id === snapshot.song_id;
    const positionSec = hit && snapshot.position_available ? snapshot.position_sec : 0;
    const playlistId = snapshot.content_type === 'playlist' ? snapshot.playlist_id : null;
    // 电台与单曲播放不启用起播确认（PlaylistManager.scheduleLandingVerify 对二者提前返回），
    // 这类内容只能沿用「下发受理」作为消费完成条件；其余内容必须等确认结果。
    const expectsLanding = snapshot.content_type === 'playlist' && snapshot.play_mode !== 'singlePlay';
    const onLandingResult = expectsLanding
      ? (result: LandingResult) => this.handleLandingResult(accountId, targetDeviceId, generation, result)
      : undefined;
    // 先登记再下发：确认回调可能早于 playPlaylist 的 await 返回触发。
    if (expectsLanding) this.activeResumes.add(key);

    try {
      const outcome = playlistId === null || playlistId <= 0
        // 电台：没有歌单，按单曲上下文下发。位置固定 0。
        ? await this.playPlaylist(accountId, targetDeviceId, 0, song, snapshot.song_index, 0, snapshot.play_mode, snapshot.speed, onLandingResult)
        : await this.playPlaylist(accountId, targetDeviceId, playlistId, song, snapshot.song_index, positionSec, snapshot.play_mode, snapshot.speed, onLandingResult);

      if (outcome === 'dispatched') {
        if (!expectsLanding) {
          // 电台/单曲播放没有起播确认，受理即视为消费完成。
          await this.pendingStore.clear(accountId, targetDeviceId);
        }
        // expectsLanding 时保留 pending，等确认结果再清除或保留。
      } else {
        // 明确失败/未知：本次没有登记中的确认，撤销登记以便用户重试。
        this.activeResumes.delete(key);
      }
      return { outcome };
    } catch (e) {
      this.activeResumes.delete(key);
      this.log(`[SwitchCoordinator] resume pending failed: ${String(e)}`);
      return { outcome: 'failed' };
    }
  }

  /**
   * 采样被判 stale 后重读当前快照，仅当它仍属于同一台源设备时返回。
   *
   * 快照按账号存一条：同账号别的设备写入时，这条快照与本次切换的源设备无关，
   * 不能拿来当这个目标的待播放上下文。
   */
  private async readFreshSnapshotForSource(accountId: string, sourceDeviceId: string): Promise<PlaybackSnapshot | null> {
    try {
      const fresh = await this.snapshotStore.read(accountId);
      if (fresh && fresh.source_device.account_id === accountId && fresh.source_device.device_id === sourceDeviceId) {
        return fresh;
      }
    } catch (e) {
      this.log(`[SwitchCoordinator] re-read snapshot after stale failed: ${String(e)}`);
    }
    return null;
  }

  /** 内容代际是否仍是消费开始时的那一代；变了说明已被「选择新内容」作废。 */
  private isGenerationCurrent(accountId: string, targetDeviceId: string, generation: number): boolean {
    return (this.contentGenerations.get(pendingKey(accountId, targetDeviceId)) ?? 0) === generation;
  }

  /**
   * 起播确认结算：只有确认成功（或确认窗口被后续操作打断）才清除 pending。
   *
   * not-landed 保留 pending，让用户可以直接重试这次恢复；landed 与 superseded 都表示
   * 本次消费已经结束，此时留着 pending 只会在下次继续时把用户拉回旧内容。
   */
  private async handleLandingResult(accountId: string, targetDeviceId: string, generation: number, result: LandingResult): Promise<void> {
    const key = pendingKey(accountId, targetDeviceId);
    if (!this.activeResumes.has(key)) return;
    // 代际已经前进（例如确认窗口内用户选了新内容）时，本次消费早已作废，不得再动存储。
    if (!this.isGenerationCurrent(accountId, targetDeviceId, generation)) {
      this.activeResumes.delete(key);
      return;
    }
    // not-landed 保留 pending；登记也同步去掉，让用户可以直接重试这次恢复。
    if (result === 'not-landed') {
      this.activeResumes.delete(key);
      return;
    }
    // landed / superseded：清除 pending。登记一直保留到清除完成，否则这段异步窗口里
    // 重复「继续」会通过 in-progress 检查、读到尚未删除的 pending 再下发一次。
    try {
      await this.clearPending(accountId, targetDeviceId);
    } finally {
      this.activeResumes.delete(key);
    }
  }

  /** 选择新内容时清除 pending，并使旧同步任务的晚到写入失效。 */
  async clearPending(accountId: string, targetDeviceId: string): Promise<void> {
    const key = pendingKey(accountId, targetDeviceId);
    this.contentGenerations.set(key, (this.contentGenerations.get(key) ?? 0) + 1);
    // 正在等待起播确认的消费随之作废：晚到的确认结果不得再动存储。
    this.activeResumes.delete(key);
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

