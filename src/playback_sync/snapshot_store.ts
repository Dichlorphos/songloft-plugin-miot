// 播放快照存储：按账号保存「最新播放快照」的观测结果。
//
// 与待播放上下文存储分开：这里按账号存一条观测，pending 按账号与目标设备存决策产物。
// 只依赖注入的存储接口，不直接触碰宿主 API，因此可以用内存 fake 做纯逻辑测试。

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
export interface PlaybackSnapshotStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface SnapshotEnvelope {
  schema_version: number;
  snapshots: Record<string, PlaybackSnapshot>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSourceDevice(value: unknown): value is PlaybackSourceDevice {
  return isObject(value) && typeof value.account_id === 'string' && typeof value.device_id === 'string';
}

/** 单条快照校验：字段错误只忽略该条，不牵连其它账号。 */
function isValidSnapshot(value: unknown): value is PlaybackSnapshot {
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
export class PlaybackSnapshotStore {
  private readonly storage: PlaybackSnapshotStorage;
  // 所有写入串成一条队列。信封是单个存储键，跨账号的并发读-改-写会互相覆盖整份数据
  // （B 账号写入时基于未包含 A 账号的旧信封，把 A 的结果抹掉），所以锁必须覆盖整个信封。
  private writeQueue: Promise<unknown> = Promise.resolve();

  // 不用参数属性：Node 的 strip-only 类型剥离不支持它，纯逻辑测试无法直接执行本文件。
  constructor(storage: PlaybackSnapshotStorage) {
    this.storage = storage;
  }

  /** 把任务串到写入队列尾部；前一个任务失败也照常执行下一个。 */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task);
    // 队列自身永不 reject，避免一次失败卡死后续写入。
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /** 读取账号当前快照；信封或单条数据无效时按「无快照」处理。 */
  async read(accountId: string): Promise<PlaybackSnapshot | null> {
    const envelope = await this.loadEnvelope();
    if (!envelope) return null;
    const snapshot = envelope.snapshots[accountId];
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
   * 本次写入按 stale 拒绝，避免旧异步任务回写覆盖新状态。
   */
  async write(input: NewPlaybackSnapshot): Promise<PlaybackSnapshotWriteResult> {
    if (!input.account_id) return { ok: false, reason: 'invalid' };
    return this.runExclusive(() => this.writeLocked(input));
  }

  private async writeLocked(input: NewPlaybackSnapshot): Promise<PlaybackSnapshotWriteResult> {
    if (!input.account_id || !Number.isInteger(input.song_id) || input.song_id <= 0) {
      return { ok: false, reason: 'invalid' };
    }

    const envelope = (await this.loadEnvelope()) ?? this.emptyEnvelope();
    const current = envelope.snapshots[input.account_id];
    const currentRevision = current?.revision ?? 0;

    if (input.base_revision !== undefined && input.base_revision !== currentRevision) {
      return { ok: false, reason: 'stale' };
    }

    const snapshot: PlaybackSnapshot = {
      ...input,
      schema_version: PLAYBACK_SNAPSHOT_SCHEMA_VERSION,
      revision: currentRevision + 1,
    };
    delete (snapshot as { base_revision?: number }).base_revision;
    envelope.snapshots[input.account_id] = snapshot;

    try {
      await this.storage.set(PLAYBACK_SNAPSHOT_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      return { ok: false, reason: 'storage_error' };
    }
    return { ok: true, snapshot };
  }

  /** 删除账号快照；新账号标识重新从 revision 1 开始。 */
  async remove(accountId: string): Promise<void> {
    const envelope = await this.loadEnvelope();
    if (!envelope || !Object.prototype.hasOwnProperty.call(envelope.snapshots, accountId)) return;
    delete envelope.snapshots[accountId];
    try {
      await this.storage.set(PLAYBACK_SNAPSHOT_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      // 删除失败不抛出：账号已删，残留快照会被下次写入或读取按无效数据处理
    }
  }

  private emptyEnvelope(): SnapshotEnvelope {
    return { schema_version: PLAYBACK_SNAPSHOT_SCHEMA_VERSION, snapshots: {} };
  }

  /** 读取信封并逐条校验；未知 schema 忽略整个信封。 */
  private async loadEnvelope(): Promise<SnapshotEnvelope | null> {
    let raw: string | null;
    try {
      raw = await this.storage.get(PLAYBACK_SNAPSHOT_STORAGE_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isObject(parsed) || parsed.schema_version !== PLAYBACK_SNAPSHOT_SCHEMA_VERSION) return null;
    if (!isObject(parsed.snapshots)) return null;

    const snapshots: Record<string, PlaybackSnapshot> = {};
    for (const [accountId, value] of Object.entries(parsed.snapshots)) {
      if (isValidSnapshot(value) && value.account_id === accountId) {
        snapshots[accountId] = value;
      }
    }
    return { schema_version: PLAYBACK_SNAPSHOT_SCHEMA_VERSION, snapshots };
  }
}