// 起播失败（#466）的决策规则。
//
// 从 PlaylistManager.handleLandingFailure 抽出的纯决策部分：只回答「该怎么办」，
// 不执行 TTS / stop / advanceToNext 等副作用。抽出来的目的有两个：
//   1. 三条验收项（I1 跳歌 / I2 电台单曲停播 / I3 熔断）可以在接缝处观察，而不必
//      穿透私有方法并等待 10+8 秒的真实定时器；
//   2. 两条触发路径（起播确认探测、外部停止探测）共用同一份判定，避免规则漂移。
//
// 边界：自动切歌「硬失败」收尾（advanceToNext 重试后仍失败）不经过本模块——那条路径
// 不跳歌、直接停播，只借用同一个熔断阈值常量。两者的共同点仅止于阈值。

/** 连续起播失败的熔断阈值：达到即停播并播报长文案。 */
export const LANDING_FAILURE_CIRCUIT_BREAK = 3;

/** 起播失败后的处理动作。 */
export type LandingFailureAction =
  /** 未达阈值且可跳歌：跳到下一首。 */
  | 'advance'
  /** 未达阈值但无可跳内容（电台/单曲播放）：按终点式停播。 */
  | 'terminal-stop'
  /** 连续多首失败：熔断停播。 */
  | 'circuit-break';

/**
 * 决定起播失败后的处理动作。
 *
 * 判定顺序有语义：熔断优先于内容类型分流。电台连续失败达阈值时同样熔断，
 * 播报「多首歌曲无法播放」而不是「当前歌曲暂时无法播放」。
 */
export function decideLandingFailure(input: {
  /** 含本次在内的连续起播失败次数。 */
  consecutiveFailures: number;
  /** 当前内容是电台（直播流，没有「下一首」语义）。 */
  isRadio: boolean;
  /** 当前处于 singlePlay 模式（播完即停，没有「下一首」语义）。 */
  isSinglePlay: boolean;
}): LandingFailureAction {
  if (input.consecutiveFailures >= LANDING_FAILURE_CIRCUIT_BREAK) return 'circuit-break';
  if (input.isRadio || input.isSinglePlay) return 'terminal-stop';
  return 'advance';
}
/** 「外部停止 + 位置极早」视为起播失败的窗口上界（秒）。 */
export const LANDING_EARLY_STOP_SEC = 15;

/**
 * 判断一次外部停止是否落在起播早期窗口内（I5）。
 *
 * 位置为负代表设备没上报位置，无法断言「没播上」，因此返回 false——宁可按普通外停
 * 处理（可由外部恢复探测自愈），也不要误判成失败去跳下一首。
 */
export function isEarlyLandingStop(positionSec: number): boolean {
  return positionSec >= 0 && positionSec < LANDING_EARLY_STOP_SEC;
}
/**
 * 连续起播失败计数器。
 *
 * 熔断只累计**连续**失败：任何一次起播确认成功都必须清零（I6），否则正常的失败重试
 * 会跨歌曲累积，把「偶发失败」误判成「整条音源都挂了」而提前熔断。
 *
 * 抽成独立类型是为了让这条契约可观察——原先是散在 manager 里的
 * `this.landingFailureCount = 0` / `++` 赋值，只能靠人读代码确认。
 */
export class LandingFailureCounter {
  private count = 0;

  /** 记一次起播失败，返回含本次在内的连续失败次数。 */
  recordFailure(): number {
    return ++this.count;
  }

  /** 起播确认成功：清零连续失败计数。 */
  recordLanded(): void {
    this.count = 0;
  }

  /** 熔断后重置，重新开始累计。 */
  reset(): void {
    this.count = 0;
  }

  /** 当前连续失败次数（诊断用）。 */
  value(): number {
    return this.count;
  }
}