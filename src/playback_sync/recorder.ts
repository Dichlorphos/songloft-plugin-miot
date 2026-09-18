// 快照采集：把播放状态机出口的一次观测，按范围规则写成账号级最新播放快照。
//
// 范围规则集中在这里，而不是散落在各调用入口：
//   - 只有正式歌单（playlist_id > 0）与电台参与
//   - 只有独立设备（单一输出目标）参与，设备组跳过
//   - 电台位置固定 0，身份沿用 song_id
// 存储失败只记录日志，绝不向上抛：快照是旁路观测，不能影响核心播放控制。

import {
  PlaybackSnapshotStore,
  type NewPlaybackSnapshot,
  type PlaybackContentType,
  type PlaybackSnapshotState,
  type PlaybackSourceDevice,
} from './snapshot_store.ts';

/** 状态机出口上报的一次播放观测。 */
export interface PlaybackObservation {
  account_id: string;
  content_type: PlaybackContentType;
  song_id: number;
  /** 正式歌单的 ID；电台为 null。临时歌单为负数。 */
  playlist_id: number | null;
  song_index: number;
  position_sec: number;
  position_available: boolean;
  speed: number;
  play_mode: string;
  state: PlaybackSnapshotState;
  source_device: PlaybackSourceDevice;
  /** 该 manager 当前下发的目标设备数；>1 表示设备组。 */
  target_count: number;
  title: string;
  artist: string;
}

/** 切换时的采样请求。 */
export interface SwitchSampleRequest {
  account_id: string;
  device_id: string;
  /** 采样源设备物理位置；返回 null 表示采样失败。 */
  samplePosition: () => Promise<number | null>;
  /** 采样超时阈值，缺省 2 秒。 */
  timeoutMs?: number;
}

export interface SwitchSampleResult {
  ok: boolean;
  reason?: 'no_snapshot' | 'sample_failed' | 'stale' | 'storage_error';
}

/** 采样超时阈值：源设备位置采样超过 2 秒视为失败。 */
export const SAMPLE_TIMEOUT_MS = 2_000;

export interface PlaybackRecorderOptions {
  now?: () => number;
  log?: (message: string) => void;
}

export class PlaybackRecorder {
  private readonly store: PlaybackSnapshotStore;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(store: PlaybackSnapshotStore, options: PlaybackRecorderOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  /**
   * 记录一次状态机出口观测。
   *
   * 返回是否真的写入；范围外与存储失败都返回 false，且都不抛出。
   */
  async record(observation: PlaybackObservation): Promise<boolean> {
    const payload = this.toSnapshotPayload(observation);
    if (!payload) return false;

    const result = await this.store.write(payload);
    if (!result.ok) {
      this.log(`[PlaybackRecorder] snapshot write skipped reason=${result.reason}`);
      return false;
    }
    return true;
  }

  /**
   * 切换请求开始时刷新源设备快照：采样物理位置并写入新 revision。
   *
   * 采样失败或尚无有效快照时保持原状：不创建新 revision，也不清除任何东西。
   */
  async sampleOnSwitch(request: SwitchSampleRequest): Promise<SwitchSampleResult> {
    const current = await this.store.read(request.account_id);
    if (!current) {
      return { ok: false, reason: 'no_snapshot' };
    }

    const position = await this.sampleWithTimeout(request.samplePosition, request.timeoutMs ?? SAMPLE_TIMEOUT_MS);
    if (position === null) {
      return { ok: false, reason: 'sample_failed' };
    }

    const result = await this.store.write({
      ...current,
      position_sec: Math.max(0, position),
      position_available: true,
      updated_at: this.now(),
      base_revision: current.revision,
    });

    if (!result.ok) {
      return { ok: false, reason: result.reason === 'stale' ? 'stale' : 'storage_error' };
    }
    return { ok: true };
  }

  /**
   * 账号被删除时清除其快照。
   *
   * 账号 ID 可能被复用，所以清除而不是保留：新账号不继承旧账号的播放上下文。
   * 失败只记录日志，不向上抛。
   */
  async forgetAccount(accountId: string): Promise<void> {
    if (!accountId) return;
    try {
      await this.store.remove(accountId);
    } catch (e) {
      this.log(`[PlaybackRecorder] forgetAccount failed: ${String(e)}`);
    }
  }
  /** 把观测映射为快照写入载荷；范围外返回 null。 */
  private toSnapshotPayload(observation: PlaybackObservation): NewPlaybackSnapshot | null {
    if (!observation.account_id) return null;
    // 设备组共享一个 manager，不做跨设备快照
    if (observation.target_count !== 1) return null;

    const isRadio = observation.content_type === 'radio';
    const isPlaylist = observation.content_type === 'playlist';

    if (isRadio) {
      // 电台没有曲内位置，也没有歌单 ID
      return {
        account_id: observation.account_id,
        content_type: 'radio',
        song_id: observation.song_id,
        playlist_id: null,
        song_index: observation.song_index,
        position_sec: 0,
        position_available: false,
        speed: 1,
        play_mode: observation.play_mode,
        state: observation.state,
        source_device: observation.source_device,
        updated_at: this.now(),
        title: observation.title,
        artist: observation.artist,
      };
    }

    if (!isPlaylist) return null;
    // 临时歌单（负数 ID）不参与；正式歌单必须有正整数 ID
    if (observation.playlist_id === null || !Number.isInteger(observation.playlist_id) || observation.playlist_id <= 0) {
      return null;
    }

    return {
      account_id: observation.account_id,
      content_type: 'playlist',
      song_id: observation.song_id,
      playlist_id: observation.playlist_id,
      song_index: observation.song_index,
      position_sec: Math.max(0, observation.position_sec),
      position_available: observation.position_available,
      speed: observation.speed,
      play_mode: observation.play_mode,
      state: observation.state,
      source_device: observation.source_device,
      updated_at: this.now(),
      title: observation.title,
      artist: observation.artist,
    };
  }

  /** 带超时的位置采样；超时或采样返回 null 都视为失败。 */
  private async sampleWithTimeout(
    samplePosition: () => Promise<number | null>,
    timeoutMs: number,
  ): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      const sampled = await Promise.race([
        samplePosition().then((value) => (value === null || !Number.isFinite(value) ? null : value)),
        timeout,
      ]);
      return sampled;
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}