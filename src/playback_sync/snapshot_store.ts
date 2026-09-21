// 播放快照存储：按账号保存「最新播放快照」的观测结果。
//
// 与待播放上下文存储分开：这里按账号存一条观测，pending 按账号与目标设备存决策产物。
// 信封的通用机制（单键 JSON、整体串行、未知 schema 忽略、坏条目逐条忽略并记诊断）在
// envelope_store.ts，本文件只保留快照自己的键、schema 与条目校验。

import { VersionedEnvelopeStore, isObject, type EnvelopeStorage } from './envelope_store.ts';

export const PLAYBACK_SNAPSHOT_STORAGE_KEY = 'playback_snapshot_v1';
export const PLAYBACK_SNAPSHOT_SCHEMA_VERSION = 1;
export const PLAYBACK_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/** 快照的内容类型：正式歌单歌曲或电台。 */
export type PlaybackContentType = 'playlist' | 'radio';

/** 快照记录的播放状态；`idle` 不属于可记录状态。 */
export type PlaybackSnapshotState = 'playing' | 'paused' | 'stopped';

/** 快照的来源设备，不保存设备名称。 */
export interface PlaybackSourceDevice {
  account_id: string;
  device_id: string;
}

/** 一条已落盘的播放快照。 */
export interface PlaybackSnapshot {
  schema_version: number;
  account_id: string;
  content_type: PlaybackContentType;
  song_id: number;
  playlist_id: number | null;
  song_index: number;
  position_sec: number;
  position_available: boolean;
  speed: number;
  play_mode: string;
  state: PlaybackSnapshotState;
  source_device: PlaybackSourceDevice;
  updated_at: number;
  revision: number;
  title: string;
  artist: string;
}

/** 调用方提供的快照内容；revision 与 schema_version 由存储分配。 */
export type NewPlaybackSnapshot = Omit<PlaybackSnapshot, 'schema_version' | 'revision'> & {
  /** 采样开始时读到的 revision；传入则拒绝已被更新覆盖的旧任务写入。 */
  base_revision?: number;
};

/** 写入结果。存储失败不抛出，交给调用方决定是否记录日志。 */
export interface PlaybackSnapshotWriteResult {
  ok: boolean;
  snapshot?: PlaybackSnapshot;
  reason?: 'stale' | 'invalid' | 'storage_error';
}

/** 快照存储所需的最小存储接口，便于测试注入内存实现。 */
export type PlaybackSnapshotStorage = EnvelopeStorage;

interface SnapshotEnvelope extends Record<string, unknown> {
  schema_version: number;
  snapshots: Record<string, PlaybackSnapshot>;
}

function isSourceDevice(value: unknown): value is PlaybackSourceDevice {
  return isObject(value) && typeof value.account_id === 'string' && typeof value.device_id === 'string';
}

/** 单条快照校验：字段错误只忽略该条，不牵连其它账号。pending 内层副本复用同一套校验。 */
export function isValidSnapshot(value: unknown): value is PlaybackSnapshot {
  if (!isObject(value)) return false;
  if (value.schema_version !== PLAYBACK_SNAPSHOT_SCHEMA_VERSION) return false;
  if (typeof value.account_id !== 'string' || !value.account_id) return false;
  if (value.content_type !== 'playlist' && value.content_type !== 'radio') return false;
  if (typeof value.song_id !== 'number' || !Number.isInteger(value.song_id) || value.song_id <= 0) return false;
  if (typeof value.song_index !== 'number' || !Number.isInteger(value.song_index)) return false;
  if (typeof value.position_sec !== 'number' || !Number.isFinite(value.position_sec)) return false;
  if (typeof value.position_available !== 'boolean') return false;
  if (typeof value.speed !== 'number' || !Number.isFinite(value.speed)) return false;
  if (typeof value.play_mode !== 'string') return false;
  if (value.state !== 'playing' && value.state !== 'paused' && value.state !== 'stopped') return false;
  if (!isSourceDevice(value.source_device)) return false;
  if (typeof value.updated_at !== 'number' || !Number.isFinite(value.updated_at)) return false;
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 1) return false;
  if (typeof value.title !== 'string' || typeof value.artist !== 'string') return false;
  // content_type 与 playlist_id 的对应关系：radio 必须为 null，playlist 必须为正整数
  if (value.content_type === 'radio') {
    if (value.playlist_id !== null) return false;
  } else if (typeof value.playlist_id !== 'number' || !Number.isInteger(value.playlist_id) || value.playlist_id <= 0) {
    return false;
  }
  return true;
}

/**
 * 播放快照存储。
 *
 * 写入按账号串行，并以账号内单调 revision 拒绝旧写入；`updated_at` 只用于诊断与过期判断。
 */
export class PlaybackSnapshotStore extends VersionedEnvelopeStore<PlaybackSnapshot, SnapshotEnvelope> {
  /**
   * 每个账号最近一次被接受的「出口序号」。
   *
   * 快照是状态机出口的观测：出口在真实状态变更之后、按先到先得的顺序发生，但写入是异步的，
   * 晚发生的出口不一定晚进存储队列。序号在出口处同步递增，因此它的顺序就是状态变更的真实顺序；
   * 序号更小的写入即使晚到也必须被拒绝，否则一条迟到的 playing 可能盖掉后来的 stopped。
   * 只存在于内存：进程重启后没有任何在途写入，从零开始即可。
   */
  private readonly acceptedOrder = new Map<string, number>();

  constructor(storage: PlaybackSnapshotStorage, options: { log?: (message: string) => void } = {}) {
    super(storage, {
      storageKey: PLAYBACK_SNAPSHOT_STORAGE_KEY,
      schemaVersion: PLAYBACK_SNAPSHOT_SCHEMA_VERSION,
      entriesField: 'snapshots',
      diagnosticsLabel: '[PlaybackSnapshotStore]',
      log: options.log,
    });
  }

  protected isValidEntry(value: unknown): value is PlaybackSnapshot {
    return isValidSnapshot(value);
  }

  protected entryKey(entry: PlaybackSnapshot): string {
    return entry.account_id;
  }

  protected emptyEnvelope(): SnapshotEnvelope {
    return { schema_version: PLAYBACK_SNAPSHOT_SCHEMA_VERSION, snapshots: {} };
  }

  protected withEntries(envelope: SnapshotEnvelope, entries: Record<string, PlaybackSnapshot>): SnapshotEnvelope {
    envelope.snapshots = entries;
    return envelope;
  }

  /** 读取账号当前快照；信封或单条数据无效时按「无快照」处理。 */
  async read(accountId: string): Promise<PlaybackSnapshot | null> {
    const loaded = await this.readEnvelope();
    if (loaded.status !== 'loaded') return null;
    const snapshot = loaded.envelope.snapshots[accountId];
    return snapshot && snapshot.account_id === accountId ? snapshot : null;
  }

  /** 是否已过期。`updated_at` 是快照时间，不是 revision 时间。 */
  isExpired(snapshot: PlaybackSnapshot, now = Date.now()): boolean {
    if (!Number.isFinite(snapshot.updated_at)) return true;
    return now - snapshot.updated_at > PLAYBACK_SNAPSHOT_TTL_MS;
  }

  /**
   * 写入一条快照，revision 在账号内单调递增。
   *
   * 传入 `base_revision` 时，若当前 revision 已不是它，说明有更晚的任务先提交，
   * 本次写入按 stale 拒绝。传入 `order` 时再按出口序号拒绝迟到的旧写入。
   */
  async write(input: NewPlaybackSnapshot, order?: number): Promise<PlaybackSnapshotWriteResult> {
    if (!input.account_id) return { ok: false, reason: 'invalid' };
    return this.runExclusive(() => this.writeLocked(input, order));
  }

  private async writeLocked(input: NewPlaybackSnapshot, order?: number): Promise<PlaybackSnapshotWriteResult> {
    if (!input.account_id || !Number.isInteger(input.song_id) || input.song_id <= 0) {
      return { ok: false, reason: 'invalid' };
    }

    const loaded = await this.readEnvelope();
    // 存储读取故障时不能按空信封继续写：那会把其它账号的快照整封抹掉。
    if (loaded.status === 'error') return { ok: false, reason: 'storage_error' };
    const envelope = loaded.status === 'loaded' ? loaded.envelope : this.emptyEnvelope();
    const current = envelope.snapshots[input.account_id];
    const currentRevision = current?.revision ?? 0;

    if (input.base_revision !== undefined && input.base_revision !== currentRevision) {
      return { ok: false, reason: 'stale' };
    }
    // 出口序号守卫：迟到的旧出口不得覆盖已经落盘的更新状态。
    if (order !== undefined && order < (this.acceptedOrder.get(input.account_id) ?? -Infinity)) {
      return { ok: false, reason: 'stale' };
    }

    const snapshot: PlaybackSnapshot = {
      ...input,
      schema_version: PLAYBACK_SNAPSHOT_SCHEMA_VERSION,
      revision: currentRevision + 1,
    };
    delete (snapshot as { base_revision?: number }).base_revision;
    envelope.snapshots[input.account_id] = snapshot;

    if (!(await this.saveEnvelope(envelope))) {
      return { ok: false, reason: 'storage_error' };
    }
    if (order !== undefined) this.acceptedOrder.set(input.account_id, order);
    return { ok: true, snapshot };
  }

  /**
   * 删除账号快照；新账号标识重新从 revision 1 开始。
   *
   * 与 write 走同一条队列：否则删除与并发写入竞争时，旧写入可能在删除之后重新落盘。
   */
  async remove(accountId: string): Promise<void> {
    return this.runExclusive(async () => {
      this.acceptedOrder.delete(accountId);
      const loaded = await this.readEnvelope();
      // 读不到就什么都不做：删除晚点还能重试，按空信封写回则可能抹掉其它账号。
      if (loaded.status !== 'loaded') return;
      const envelope = loaded.envelope;
      if (!Object.prototype.hasOwnProperty.call(envelope.snapshots, accountId)) return;
      delete envelope.snapshots[accountId];
      // 删除失败不抛出：账号已删，残留快照会被下次写入或读取按无效数据处理
      await this.saveEnvelope(envelope);
    });
  }
}
