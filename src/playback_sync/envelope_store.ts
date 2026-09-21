// 版本化信封存储的共同骨架。
//
// 播放快照存储与待播放上下文存储是两个独立模块、两个独立存储键，键空间与生命周期都不同，
// 但「一个存储键装一份 JSON 信封、写操作对整个信封串行、未知 schema 忽略整封、坏条目
// 逐条忽略并记诊断」这套机制是同一条，不必各写一份。这里只抽出这套机制；各 store 保留
// 自己的键、schema、条目字段名与条目校验。
//
// 为什么锁必须覆盖整个信封：信封是单个存储键，跨账号的并发读-改-写会互相覆盖
// （B 账号写入时基于未包含 A 账号的旧信封，把 A 的结果抹掉）。

/** 存储层只需要 get/set 两个能力，便于测试注入内存实现。 */
export interface EnvelopeStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 一次信封读取的结果。
 *
 * - `loaded`：信封可用。
 * - `empty`：没有数据、内容不是 JSON、或 schema 未知——按「无数据」处理，可以安全重建。
 * - `error`：存储读取抛错。这是瞬时故障，**不能**当成「没有数据」：当成没有数据去写入会
 *   把整封信封（含其它账号）覆盖掉；当成「没有 pending」则会让继续操作静默回退到另一个内容。
 */
export type EnvelopeLoadResult<TEnvelope> =
  | { status: 'loaded'; envelope: TEnvelope }
  | { status: 'empty' }
  | { status: 'error'; message: string };

export interface EnvelopeStoreOptions {
  storageKey: string;
  schemaVersion: number;
  /** 信封里承载条目集合的字段名，如 snapshots / pending。 */
  entriesField: string;
  /** 诊断日志前缀，如 [PlaybackSnapshotStore]。 */
  diagnosticsLabel: string;
  log?: (message: string) => void;
}

/**
 * 版本化信封存储基类。
 *
 * 子类提供：单条校验（isValidEntry）、条目的领域主键（entryKey）、空信封与条目表读写。
 */
export abstract class VersionedEnvelopeStore<TEntry, TEnvelope> {
  protected readonly storage: EnvelopeStorage;
  protected readonly storageKey: string;
  protected readonly schemaVersion: number;
  private readonly entriesField: string;
  private readonly diagnosticsLabel: string;
  private readonly log: (message: string) => void;
  // 所有写入串成一条队列。信封是单个存储键，跨账号的并发读-改-写会互相覆盖整份数据。
  private writeQueue: Promise<unknown> = Promise.resolve();

  protected constructor(storage: EnvelopeStorage, options: EnvelopeStoreOptions) {
    this.storage = storage;
    this.storageKey = options.storageKey;
    this.schemaVersion = options.schemaVersion;
    this.entriesField = options.entriesField;
    this.diagnosticsLabel = options.diagnosticsLabel;
    this.log = options.log ?? (() => {});
  }

  /** 单条条目是否合法；不合法只忽略该条并记诊断。 */
  protected abstract isValidEntry(value: unknown): value is TEntry;

  /** 条目的领域主键：用于确认映射键与条目自身声明一致。 */
  protected abstract entryKey(entry: TEntry): string;

  /** 构造一份空信封（schema 与条目字段齐备）。 */
  protected abstract emptyEnvelope(): TEnvelope;

  /** 把条目表写回信封。 */
  protected abstract withEntries(envelope: TEnvelope, entries: Record<string, TEntry>): TEnvelope;

  /** 把任务串到写入队列尾部；前一个任务失败也照常执行下一个。 */
  protected runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task);
    // 队列自身永不 reject，避免一次失败卡死后续写入。
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /** 读取整份信封，区分「无数据/未知 schema」与「存储读不了」。 */
  protected async readEnvelope(): Promise<EnvelopeLoadResult<TEnvelope>> {
    let raw: string | null;
    try {
      raw = await this.storage.get(this.storageKey);
    } catch (e) {
      const message = `${this.diagnosticsLabel} read failed from ${this.storageKey}: ${String(e)}`;
      this.log(message);
      return { status: 'error', message: String(e) };
    }
    if (!raw) return { status: 'empty' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // 损坏的信封按「无数据」处理（规范：未知或无效 schema 忽略整个信封）。
      this.log(`${this.diagnosticsLabel} envelope parse failed in ${this.storageKey}: ${String(e)}`);
      return { status: 'empty' };
    }
    if (!isObject(parsed) || parsed.schema_version !== this.schemaVersion) {
      const found = isObject(parsed) ? String(parsed.schema_version) : 'n/a';
      this.log(`${this.diagnosticsLabel} envelope schema unsupported in ${this.storageKey}: ${found}`);
      return { status: 'empty' };
    }
    const rawEntries = parsed[this.entriesField];
    if (!isObject(rawEntries)) {
      this.log(`${this.diagnosticsLabel} envelope field missing in ${this.storageKey}: ${this.entriesField}`);
      return { status: 'empty' };
    }

    return { status: 'loaded', envelope: this.withEntries(this.emptyEnvelope(), this.collectValidEntries(rawEntries)) };
  }

  /** 逐条校验；坏条目只忽略该条并记录诊断（规范要求）。 */
  private collectValidEntries(rawEntries: Record<string, unknown>): Record<string, TEntry> {
    const entries: Record<string, TEntry> = {};
    let dropped = 0;
    for (const [key, value] of Object.entries(rawEntries)) {
      if (this.isValidEntry(value) && this.entryKey(value) === key) {
        entries[key] = value;
      } else {
        dropped++;
      }
    }
    if (dropped > 0) {
      this.log(`${this.diagnosticsLabel} dropped ${dropped} invalid entry(ies) from ${this.storageKey}`);
    }
    return entries;
  }

  /** 落盘整份信封；失败返回 false，从不抛出。 */
  protected async saveEnvelope(envelope: TEnvelope): Promise<boolean> {
    try {
      await this.storage.set(this.storageKey, JSON.stringify(envelope));
      return true;
    } catch (e) {
      this.log(`${this.diagnosticsLabel} write failed to ${this.storageKey}: ${String(e)}`);
      return false;
    }
  }
}
