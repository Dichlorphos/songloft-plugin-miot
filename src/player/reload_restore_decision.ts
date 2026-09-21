// 重启恢复的纯决策部分：只回答「锚点该还原成什么、要不要去查设备、查到之后要不要接管」。
//
// 从 PlaylistManager.resumeAfterReload 抽出。原因与 landing_failure.ts 相同：判定规则原先和
// 定时器、设备查询、状态赋值缠在同一个方法里，只能靠读完整个异步流程才敢改；抽出来后每条
// 规则都能直接喂输入看输出，尤其是「什么时候绝对不许把音箱叫起来」这条硬条件。
//
// 两条铁律（规格「重启恢复用硬条件判定」）：
//   1. 拿不到「设备确实还在放我们这条流」的硬证据，一律钉死 stopped，**绝不重推 URL**；
//   2. paused / stopped 锚点只还原本地状态与位置，一个设备指令都不发。

export type ReloadRestorePlan =
  /** 锚点与当前歌曲不符、位置非法或状态不可恢复：什么都不做。 */
  | { action: 'ignore' }
  /** paused：只还原本地暂停状态与位置，不碰设备。 */
  | { action: 'restore-paused'; positionSec: number }
  /** stopped：只还原本地停止状态与位置，不碰设备。 */
  | { action: 'restore-stopped'; positionSec: number }
  /** 需要查一次设备状态才能决定是否接管（playing 且有接管资格）。 */
  | { action: 'query-device'; estimatedPositionSec: number; anchorSeekOffsetSec: number }
  /** 直接钉死 stopped，连设备都不查。 */
  | { action: 'pin-stopped'; positionSec: number; reason: string };

export interface ReloadAnchorInput {
  /** 锚点状态；只有 playing / paused / stopped 有恢复语义。 */
  anchorState: string;
  anchorPositionSec: number;
  /** 锚点写下时刻；旧数据可能缺（0 或非有限值）。 */
  anchorAtMs: number;
  /** 锚点对应的流内起播偏移；旧数据可能缺。 */
  anchorSeekOffsetSec: number;
  /** 锚点歌曲是否仍是当前歌曲。 */
  matchesCurrentSong: boolean;
  /** 判据 3：上次是否正常卸载（onDeinit 完整跑完）。 */
  allowTakeover: boolean;
  /** 当前时刻，用于按倍速外推锚点位置。 */
  now: number;
  speed: number;
}

/**
 * 第一步：只看锚点本身，决定还原动作，或是否需要去查设备。
 *
 * 不可信锚点（atMs <= 0）按「刚写下」处理而不是按纪元外推——否则会算出天文数字位置。
 * 它最终仍由第二步的硬条件决定要不要接管。
 */
export function planReloadRestore(input: ReloadAnchorInput): ReloadRestorePlan {
  if (!input.matchesCurrentSong) return { action: 'ignore' };
  if (!Number.isFinite(input.anchorPositionSec) || input.anchorPositionSec < 0) return { action: 'ignore' };

  const anchorAtMs = Number.isFinite(input.anchorAtMs) && input.anchorAtMs > 0 ? input.anchorAtMs : input.now;
  const anchorSeekOffsetSec =
    Number.isFinite(input.anchorSeekOffsetSec) && input.anchorSeekOffsetSec > 0 ? input.anchorSeekOffsetSec : 0;
  const ageMs = Math.max(0, input.now - anchorAtMs);
  const estimatedPositionSec = input.anchorPositionSec + (ageMs / 1000) * input.speed;

  if (input.anchorState === 'paused') {
    return { action: 'restore-paused', positionSec: input.anchorPositionSec };
  }
  if (input.anchorState === 'stopped') {
    return { action: 'restore-stopped', positionSec: input.anchorPositionSec };
  }
  if (input.anchorState !== 'playing') return { action: 'ignore' };

  // 判据 3：上次不是正常卸载 → 连设备都不查，直接钉死。这正是防隔夜叫醒的关键分支。
  if (!input.allowTakeover) {
    return { action: 'pin-stopped', positionSec: estimatedPositionSec, reason: 'last shutdown was not clean' };
  }

  return { action: 'query-device', estimatedPositionSec, anchorSeekOffsetSec };
}

export interface DeviceStreamState {
  status: number;
  position: number;
  duration: number;
}

export type ReloadTakeoverDecision =
  /** 硬证据成立：设备确实还在放我们这条流，可以接管定时器。 */
  | { action: 'takeover'; devicePositionSec: number }
  /** 没有硬证据：钉死 stopped 并记下位置，绝不重推 URL。 */
  | { action: 'pin-stopped'; positionSec: number; reason: string };

/**
 * 第二步：拿到设备状态后的硬条件判定。
 *
 * 只有「设备状态为播放（status === 1）」且「上报流长与预期相符（streamMatch === ours）」才算
 * 硬证据。查不到状态（null / status < 0）、流长对不上、流长未上报（unknown）都一律钉死。
 */
export function decideReloadTakeover(input: {
  deviceState: DeviceStreamState | null;
  /** 设备上报流长与「我们推的那条流」的比对结果，由 matchDeviceStream 给出。 */
  streamMatch: 'ours' | 'foreign' | 'unknown';
  estimatedPositionSec: number;
  anchorSeekOffsetSec: number;
  speed: number;
}): ReloadTakeoverDecision {
  const { deviceState } = input;
  if (!deviceState || deviceState.status < 0) {
    return { action: 'pin-stopped', positionSec: input.estimatedPositionSec, reason: 'device state unavailable' };
  }

  if (deviceState.status === 1 && input.streamMatch === 'ours') {
    // 设备实测位置优先（它才知道缓冲耗了多久）；没上报就用外推值
    const devicePositionSec = deviceState.position > 0
      ? deviceState.position * input.speed + input.anchorSeekOffsetSec
      : input.estimatedPositionSec;
    return { action: 'takeover', devicePositionSec };
  }

  return {
    action: 'pin-stopped',
    positionSec: input.estimatedPositionSec,
    reason: `device not verifiably playing our stream (status=${deviceState.status} deviceDuration=${deviceState.duration}s)`,
  };
}

/** 把钉死位置夹进歌曲时长；未知时长时原样保留。 */
export function clampStopPosition(positionSec: number, songDuration: number): number {
  return Math.max(0, songDuration > 0 ? Math.min(positionSec, songDuration) : positionSec);
}
