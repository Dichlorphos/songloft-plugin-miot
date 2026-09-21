# 待播放上下文应在确认起播后才清除，而不是下发受理后

Type: task
Status: needs-triage
Blocked by: 02

## 问题

规格 `.scratch/playback-sync/spec.md` 第 47 行：

> 继续操作等待同一目标的异步同步任务。加载与起播分离：准备歌单、歌曲、位置、倍速、模式和 paused/stopped 状态时不生成 URL、不启动切歌定时器；准备成功后才下发，**确认起播成功才提交新活动上下文并清除待播放上下文**。

当前实现是在「下发被受理」时就清除：`SwitchCoordinator.tryResumePending` 拿到
`playPendingContext` 返回 `succeeded` 即 `pendingStore.clear(...)`（`src/playback_sync/switch_coordinator.ts:372-383`）。

而 `succeeded` 的真实含义只是「`manager.gracefulPlay(...)` 返回 true」——`playCurrent` 成功下发、
建立本地 `playing` 状态与切歌定时器。设备是否真的拉到了流，要等起播确认
（`scheduleLandingVerify`，默认 10s + 8s 两轮，`src/player/manager.ts:1530-1545`）才知道。

## 可复现的后果

`succeeded` 只代表云端受理（不是设备真的出声）。若设备没拉流：

1. `tryResumePending` 已按 `succeeded` 清除了 pending；
2. 起播确认判定失败，`handleLandingFailure` 把这台设备当作起播失败处理
   （正式歌单会跳到下一首或熔断停播，见 `#466`）；
3. 用户此时再点「继续播放」，已经没有 pending 可消费，会回退到目标设备自己的
   活动上下文——或者根本没有歌单可播，只能看到「没有正在播放的内容」。

原本想恢复的那条上下文就此丢失，而它恰恰是起播失败时最该保留的东西。

## 期望

清除时机应收在「确认起播成功」之后。可选方向：

- `playPendingContext` 不立即返回 `succeeded`，而是等待起播确认结果（会拉长继续操作的响应时间，需权衡）；
- 或让 `PlaylistManager` 暴露起播确认的最终结果，由协调器在确认成功时清除 pending、
  确认失败时保留——`succeeded` 仅表示已下发（语义要改名以免继续被误读）。

注意电台不启用起播确认（`scheduleLandingVerify` 对 `radio` 提前返回），
电台路径只能沿用「下发受理」语义，需要在规格里写明这条例外。

## 影响范围

- `src/playback_sync/switch_coordinator.ts`（清除时机）
- `src/playback_sync/host_deps.ts`（`playPendingContext` 的返回值语义）
- `src/player/manager.ts`（起播确认结果需要能对外表达）
- 真机验收票据 03 的 G2/G3（toggle/resume 优先消费待播放上下文）与 I1–I3（起播失败处理）

## Comments

- 2026-09-21：真机验收前第五轮对抗性排查时发现。用探针复现：`playPlaylist` 返回 `succeeded`
  但设备实际未拉流时，`pending` 已被清除（`PROBE18 outcome=succeeded pendingAfter=CLEARED`）。
  因涉及跨模块返回值语义变更与响应时间权衡，按 issue tracker 约定登记为独立票据，
  不塞进正在收尾的评审整改。
