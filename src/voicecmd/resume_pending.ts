// 语音/AI/网页「继续播放」共用的待播放上下文优先规则。
//
// 单独成一个纯函数，是为了让这条规格要求（明确 resume 优先使用有效待播放上下文，
// 没有 pending 才回退目标原活动上下文）能用轻量测试锁住，而不必把 VoiceEngine
// 的整条 AI 兜底链拉进测试。
//
// 调用方：VoiceEngine.executeResume、POST /player/toggle、POST /player/play(start_position=resume)。
// 三处都必须在「目标没有已加载歌单」之前先问这里，否则切到新设备后目标 manager 为空，
// 用户说「继续播放」会被拒成「没有正在播放的内容」。

export type ResumePendingOutcome = 'dispatched' | 'in-progress' | 'failed' | 'unknown' | 'none';

export interface PendingResumeDecision {
  /** true 表示待播放上下文已被处理（成功或失败），调用方不应再回退目标原上下文。 */
  handled: boolean;
  outcome: ResumePendingOutcome;
}

export interface ResumePendingDeps {
  /** 返回该目标的有效待播放上下文消费结果；`none` 表示没有可用 pending。 */
  tryResumePending: () => Promise<{ outcome: ResumePendingOutcome }>;
  log?: (message: string) => void;
}

/**
 * 明确「继续播放」时优先消费待播放上下文。
 *
 * - `dispatched` / `in-progress` / `failed` / `unknown`：上下文存在且已被处理（失败与未知也要如实上报，
 *   不能静默回退到目标原上下文，否则用户会听到另一个内容且无法解释）；
 * - `none`：没有可用待播放上下文，交回调用方走目标原活动上下文。
 *
 * 本函数不抛：消费过程出错按 `failed` 处理，仍算 handled，避免回退掩盖失败。
 */
export async function resumePendingFirst(deps: ResumePendingDeps): Promise<PendingResumeDecision> {
  try {
    const result = await deps.tryResumePending();
    if (result.outcome === 'none') return { handled: false, outcome: 'none' };
    return { handled: true, outcome: result.outcome };
  } catch (e) {
    deps.log?.(`[resume_pending] resume pending failed: ${String(e)}`);
    return { handled: true, outcome: 'failed' };
  }
}

/** 只依赖「能消费待播放上下文」这一件事，避免本模块耦合到播放同步的宿主装配。 */
export interface ResumePendingCoordinator {
  tryResumePending(accountId: string, deviceId: string): Promise<{ outcome: ResumePendingOutcome }>;
}

export interface ResumePendingIfAvailableDeps {
  /** 取全局切换编排器；未初始化时返回 null（对应「没有待播放上下文」）。 */
  getCoordinator: () => ResumePendingCoordinator | null;
  accountId: string;
  deviceId: string;
  log?: (message: string) => void;
}

/**
 * 三个「继续播放」入口共用的第一步：取协调器，再问有没有可消费的待播放上下文。
 *
 * 收在这里是为了让「没有待播放上下文才回退目标原活动上下文」这条规则只有一处实现。
 * 以前三处各自取协调器、各自 branch，任何一处漏判都会变成「切到新设备后说继续，
 * 结果播的是目标设备原来的内容」。各入口只负责把自己的结果塑造成响应或语音播报。
 */
export async function resumePendingIfAvailable(deps: ResumePendingIfAvailableDeps): Promise<PendingResumeDecision> {
  const coordinator = deps.getCoordinator();
  if (!coordinator) return { handled: false, outcome: 'none' };
  return resumePendingFirst({
    tryResumePending: () => coordinator.tryResumePending(deps.accountId, deps.deviceId),
    log: deps.log,
  });
}
