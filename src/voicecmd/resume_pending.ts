// 语音/AI「继续播放」的 pending 优先规则。
//
// 单独成一个纯函数，是为了让这条规格要求（明确 resume 优先使用有效待播放上下文，
// 没有 pending 才回退目标原活动上下文）能用轻量测试锁住，而不必把 VoiceEngine
// 的整条 AI 兜底链拉进测试。
//
// 调用方：VoiceEngine.executeResume —— 在「目标没有已加载歌单」之前先问这里，
// 否则切到新设备后目标 manager 为空，用户说「继续播放」会被拒成「没有正在播放的内容」。

export type ResumePendingOutcome = 'succeeded' | 'failed' | 'unknown' | 'none';

export interface PendingResumeDecision {
  /** true 表示 pending 已被处理（成功或失败），调用方不应再回退目标原上下文。 */
  handled: boolean;
  outcome: ResumePendingOutcome;
}

export interface ResumePendingDeps {
  /** 返回该目标的有效待播放上下文消费结果；`none` 表示没有可用 pending。 */
  tryResumePending: () => Promise<{ outcome: ResumePendingOutcome }>;
  log?: (message: string) => void;
}

/**
 * 明确「继续播放」时优先消费 pending。
 *
 * - `succeeded` / `failed` / `unknown`：pending 存在且已被处理（失败也要如实上报，
 *   不能静默回退到目标原上下文，否则用户会听到另一个内容且无法解释）；
 * - `none`：没有可用 pending，交回调用方走目标原活动上下文。
 *
 * 本函数不抛：消费过程出错按 `failed` 处理，仍算 handled，避免回退掩盖失败。
 */
export async function resumePendingFirst(deps: ResumePendingDeps): Promise<PendingResumeDecision> {
  try {
    const result = await deps.tryResumePending();
    if (result.outcome === 'none') return { handled: false, outcome: 'none' };
    return { handled: true, outcome: result.outcome };
  } catch (e) {
    deps.log?.(`[VoiceEngine] resume pending failed: ${String(e)}`);
    return { handled: true, outcome: 'failed' };
  }
}
