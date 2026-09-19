// 待播放上下文存储：按「账号 + 目标设备」保存切换时排队的决策产物。
//
// 与播放快照存储分开：快照是按账号的观测结果，pending 是按账号与目标设备的决策产物。
// 两者的键空间、生命周期与失效规则都不同，所以各用各的存储键，不共用一个信封。
//
// pending 保存的是快照的完整不可变副本：源快照之后怎么变都不影响已排队的这个目标。

import type { PlaybackSnapshot } from './snapshot_store.ts';

export const PENDING_CONTEXT_STORAGE_KEY = 'playback_pending_v1';
export const PENDING_CONTEXT_SCHEMA_VERSION = 1;
export const PENDING_CONTEXT_TTL_MS = 30 * 60 * 1000;

/** 一条待播放上下文：快照副本 + 排队元数据。 */
export interface PendingContext {
  schema_version: number;
  account_id: string;
  target_device_id: string;
  /** 入队时源快照的 revision，用于诊断与旧任务失效判定。 */
  source_revision: number;
  /** 首次写入时刻；同一内容去重时不刷新。 */
  created_at: number;
  /** 首次写入时刻 + 有效期；去重时不刷新。 */
  expires_at: number;
  snapshot: PlaybackSnapshot;
}

/** 写入请求。 */
export interface PendingContextWrite {
  account_id: string;
  target_device_id: string;
  source_revision: number;
  snapshot: PlaybackSnapshot;
  now: number;
  /** 写入时读到的 source_revision；传入则拒绝已被更新覆盖的旧任务。 */
  base_source_revision?: number;
  /** 在写锁内、真正写入前复查任务是否仍有效；返回 false 时按 stale 拒绝。 */
  shouldWrite?: () => boolean;
}

export interface PendingContextWriteResult {
  ok: boolean;
  deduped?: boolean;
  reason?: 'stale' | 'invalid' | 'storage_error';
}

/** 待播放上下文存储所需的最小存储接口。 */
export interface PendingContextStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

interface PendingEnvelope {
  schema_version: number;
  pending: Record<string, PendingContext>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 组合键：账号与目标设备共同定位一条 pending。 */
export function pendingKey(accountId: string, targetDeviceId: string): string {
  return `${accountId}:${targetDeviceId}`;
}

/** 单条 pending 校验；字段错误只忽略该条。 */
function isValidPending(value: unknown): value is PendingContext {
  if (!isObject(value)) return false;
  if (value.schema_version !== PENDING_CONTEXT_SCHEMA_VERSION) return false;
  if (typeof value.account_id !== 'string' || !value.account_id) return false;
  if (typeof value.target_device_id !== 'string' || !value.target_device_id) return false;
  if (typeof value.source_revision !== 'number' || !Number.isInteger(value.source_revision)) return false;
  if (typeof value.created_at !== 'number' || !Number.isFinite(value.created_at)) return false;
  if (typeof value.expires_at !== 'number' || !Number.isFinite(value.expires_at)) return false;
  if (!isObject(value.snapshot)) return false;
  return true;
}

/** 内容是否相同：以快照身份与位置状态为准，用于去重。 */
function sameContent(a: PlaybackSnapshot, b: PlaybackSnapshot): boolean {
  return (
    a.content_type === b.content_type &&
    a.song_id === b.song_id &&
    a.playlist_id === b.playlist_id &&
    a.song_index === b.song_index &&
    a.state === b.state
  );
}

/**
 * 待播放上下文存储。
 *
 * 写入按「账号 + 目标设备」串行，避免并发读-改-写互相覆盖；整个信封是一把锁，
 * 因为所有 pending 共用同一个存储键。
 */
export class PendingContextStore {
  private readonly storage: PendingContextStorage;
  private writeQueue: Promise<unknown> = Promise.resolve();

  // 不用参数属性：Node 的 strip-only 类型剥离不支持它，纯逻辑测试无法直接执行本文件。
  constructor(storage: PendingContextStorage) {
    this.storage = storage;
  }

  /** 把任务串到写入队列尾部；前一个任务失败也照常执行下一个。 */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /** 读取待播放上下文；过期、信封无效或字段错误都按「无上下文」处理。 */
  async read(accountId: string, targetDeviceId: string, now: number): Promise<PendingContext | null> {
    const envelope = await this.loadEnvelope();
    if (!envelope) return null;
    const pending = envelope.pending[pendingKey(accountId, targetDeviceId)];
    if (!pending) return null;
    if (pending.account_id !== accountId || pending.target_device_id !== targetDeviceId) return null;
    if (now > pending.expires_at) return null;
    return pending;
  }

  /**
   * 写入待播放上下文。
   *
   * 同一内容且同一 source_revision 视为去重：不替换、不刷新有效期。
   * 内容或 source_revision 变化才替换并重新计时。
   */
  async write(request: PendingContextWrite): Promise<PendingContextWriteResult> {
    if (!request.account_id || !request.target_device_id) return { ok: false, reason: 'invalid' };
    return this.runExclusive(() => this.writeLocked(request));
  }

  private async writeLocked(request: PendingContextWrite): Promise<PendingContextWriteResult> {
    const envelope = (await this.loadEnvelope()) ?? this.emptyEnvelope();
    const key = pendingKey(request.account_id, request.target_device_id);
    // 在写锁内部复查：clear() 与旧异步写入并发时，避免旧任务在清除之后重新落盘。
    if (request.shouldWrite && !request.shouldWrite()) {
      return { ok: false, reason: 'stale' };
    }
    const existing = envelope.pending[key];

    // 旧异步任务：以过期基准提交的写入不得覆盖更新的上下文
    if (request.base_source_revision !== undefined) {
      const currentRevision = existing?.source_revision ?? -1;
      if (request.base_source_revision !== currentRevision) {
        return { ok: false, reason: 'stale' };
      }
    }

    if (existing && existing.source_revision === request.source_revision && sameContent(existing.snapshot, request.snapshot)) {
      return { ok: true, deduped: true };
    }

    const pending: PendingContext = {
      schema_version: PENDING_CONTEXT_SCHEMA_VERSION,
      account_id: request.account_id,
      target_device_id: request.target_device_id,
      source_revision: request.source_revision,
      created_at: request.now,
      expires_at: request.now + PENDING_CONTEXT_TTL_MS,
      // 深拷贝：调用方之后改动源快照不得影响已排队的目标内容
      snapshot: JSON.parse(JSON.stringify(request.snapshot)) as PlaybackSnapshot,
    };
    envelope.pending[key] = pending;

    try {
      await this.storage.set(PENDING_CONTEXT_STORAGE_KEY, JSON.stringify(envelope));
    } catch {
      return { ok: false, reason: 'storage_error' };
    }
    return { ok: true };
  }

  /** 清除单个目标的待播放上下文（用户选择新内容时）。 */
  async clear(accountId: string, targetDeviceId: string): Promise<void> {
    return this.runExclusive(async () => {
      const envelope = await this.loadEnvelope();
      if (!envelope) return;
      const key = pendingKey(accountId, targetDeviceId);
      if (!Object.prototype.hasOwnProperty.call(envelope.pending, key)) return;
      delete envelope.pending[key];
      try {
        await this.storage.set(PENDING_CONTEXT_STORAGE_KEY, JSON.stringify(envelope));
      } catch {
        // 清除失败不抛出：残留项会被有效期或下次写入覆盖
      }
    });
  }

  /** 账号删除时清除其全部待播放上下文。 */
  async removeAccount(accountId: string): Promise<void> {
    return this.runExclusive(async () => {
      const envelope = await this.loadEnvelope();
      if (!envelope) return;
      let changed = false;
      for (const key of Object.keys(envelope.pending)) {
        if (envelope.pending[key].account_id === accountId) {
          delete envelope.pending[key];
          changed = true;
        }
      }
      if (!changed) return;
      try {
        await this.storage.set(PENDING_CONTEXT_STORAGE_KEY, JSON.stringify(envelope));
      } catch {
        // 同上：删除失败不抛出
      }
    });
  }

  private emptyEnvelope(): PendingEnvelope {
    return { schema_version: PENDING_CONTEXT_SCHEMA_VERSION, pending: {} };
  }

  /** 读取信封并逐条校验；未知 schema 忽略整个信封。 */
  private async loadEnvelope(): Promise<PendingEnvelope | null> {
    let raw: string | null;
    try {
      raw = await this.storage.get(PENDING_CONTEXT_STORAGE_KEY);
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
    if (!isObject(parsed) || parsed.schema_version !== PENDING_CONTEXT_SCHEMA_VERSION) return null;
    if (!isObject(parsed.pending)) return null;

    const pending: Record<string, PendingContext> = {};
    for (const [key, value] of Object.entries(parsed.pending)) {
      if (isValidPending(value) && key === pendingKey(value.account_id, value.target_device_id)) {
        pending[key] = value;
      }
    }
    return { schema_version: PENDING_CONTEXT_SCHEMA_VERSION, pending };
  }
}
