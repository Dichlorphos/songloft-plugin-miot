// 待播放上下文存储：按「账号 + 目标设备」保存切换时排队的决策产物。
//
// 与播放快照存储分开：快照是按账号的观测结果，pending 是按账号与目标设备的决策产物。
// 两者的键空间、生命周期与失效规则都不同，所以各用各的存储键，不共用一个信封。
// 信封的通用机制（单键 JSON、整体串行、未知 schema 忽略、坏条目逐条忽略并记诊断）在
// envelope_store.ts，本文件只保留 pending 自己的键、schema 与条目校验。
//
// pending 保存的是快照的完整不可变副本：源快照之后怎么变都不影响已排队的这个目标。

import { VersionedEnvelopeStore, isObject, type EnvelopeStorage } from './envelope_store.ts';
import { isValidSnapshot, type PlaybackSnapshot } from './snapshot_store.ts';

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

/**
 * 读取结果。
 *
 * `error` 是存储故障，**不等于**「没有待播放上下文」：调用方必须把它当作失败如实上报，
 * 否则一次瞬时读故障就会让「继续播放」静默回退到目标原活动上下文，播成另一个内容。
 */
export type PendingReadResult =
  | { status: 'found'; pending: PendingContext }
  | { status: 'none' }
  | { status: 'error'; message: string };

/** 待播放上下文存储所需的最小存储接口。 */
export type PendingContextStorage = EnvelopeStorage;

interface PendingEnvelope extends Record<string, unknown> {
  schema_version: number;
  pending: Record<string, PendingContext>;
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
  // 内层快照是契约的一部分：只检查「是个对象」会让坏副本一路带到恢复路径。
  if (!isValidSnapshot(value.snapshot)) return false;
  // 副本必须属于同一个账号，否则跨账号数据会被当成有效待播放上下文。
  if (value.snapshot.account_id !== value.account_id) return false;
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
export class PendingContextStore extends VersionedEnvelopeStore<PendingContext, PendingEnvelope> {
  constructor(storage: PendingContextStorage, options: { log?: (message: string) => void } = {}) {
    super(storage, {
      storageKey: PENDING_CONTEXT_STORAGE_KEY,
      schemaVersion: PENDING_CONTEXT_SCHEMA_VERSION,
      entriesField: 'pending',
      diagnosticsLabel: '[PendingContextStore]',
      log: options.log,
    });
  }

  protected isValidEntry(value: unknown): value is PendingContext {
    return isValidPending(value);
  }

  protected entryKey(entry: PendingContext): string {
    return pendingKey(entry.account_id, entry.target_device_id);
  }

  protected emptyEnvelope(): PendingEnvelope {
    return { schema_version: PENDING_CONTEXT_SCHEMA_VERSION, pending: {} };
  }

  protected withEntries(envelope: PendingEnvelope, entries: Record<string, PendingContext>): PendingEnvelope {
    envelope.pending = entries;
    return envelope;
  }

  /**
   * 读取待播放上下文；过期或不存在都返回 null。
   *
   * 这是给「只看有没有」的调用方用的便捷读取。存储故障同样表现为 null，因此**决策路径
   * 不要用它**——需要区分「没有」与「读不了」时用 `readWithStatus`。
   */
  async read(accountId: string, targetDeviceId: string, now: number): Promise<PendingContext | null> {
    const result = await this.readWithStatus(accountId, targetDeviceId, now);
    return result.status === 'found' ? result.pending : null;
  }

  /**
   * 读取待播放上下文，并区分「没有」与「读不了」。
   *
   * 过期视为「无」；存储读故障返回 `error`，由调用方决定如何上报——绝大多数情况下
   * 应当如实报失败，而不是当成「没有待播放上下文」回退到另一个内容。
   */
  async readWithStatus(accountId: string, targetDeviceId: string, now: number): Promise<PendingReadResult> {
    const loaded = await this.readEnvelope();
    if (loaded.status === 'error') return { status: 'error', message: loaded.message };
    if (loaded.status === 'empty') return { status: 'none' };

    const pending = loaded.envelope.pending[pendingKey(accountId, targetDeviceId)];
    if (!pending) return { status: 'none' };
    if (pending.account_id !== accountId || pending.target_device_id !== targetDeviceId) return { status: 'none' };
    if (now > pending.expires_at) return { status: 'none' };
    return { status: 'found', pending };
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
    const loaded = await this.readEnvelope();
    // 读取故障时不按空信封继续写：那会把其它账号与目标的 pending 整封抹掉。
    if (loaded.status === 'error') return { ok: false, reason: 'storage_error' };
    const envelope = loaded.status === 'loaded' ? loaded.envelope : this.emptyEnvelope();
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

    if (!(await this.saveEnvelope(envelope))) {
      return { ok: false, reason: 'storage_error' };
    }
    return { ok: true };
  }

  /** 清除单个目标的待播放上下文（用户选择新内容时）。 */
  async clear(accountId: string, targetDeviceId: string): Promise<void> {
    return this.runExclusive(async () => {
      const loaded = await this.readEnvelope();
      // 读不到就不写：删除是幂等的，晚点重试即可；按空信封写回会抹掉其它条目。
      if (loaded.status !== 'loaded') return;
      const envelope = loaded.envelope;
      const key = pendingKey(accountId, targetDeviceId);
      if (!Object.prototype.hasOwnProperty.call(envelope.pending, key)) return;
      delete envelope.pending[key];
      // 清除失败不抛出：残留项会被有效期或下次写入覆盖
      await this.saveEnvelope(envelope);
    });
  }

  /** 账号删除时清除其全部待播放上下文。 */
  async removeAccount(accountId: string): Promise<void> {
    return this.runExclusive(async () => {
      const loaded = await this.readEnvelope();
      if (loaded.status !== 'loaded') return;
      const envelope = loaded.envelope;
      let changed = false;
      for (const key of Object.keys(envelope.pending)) {
        if (envelope.pending[key].account_id === accountId) {
          delete envelope.pending[key];
          changed = true;
        }
      }
      if (!changed) return;
      // 同上：删除失败不抛出
      await this.saveEnvelope(envelope);
    });
  }
}
