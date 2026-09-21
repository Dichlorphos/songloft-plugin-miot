# 待播放上下文应在确认起播后才清除，而不是下发受理后

Type: task
Status: done
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

## Answer

按 ADR-0003 实现：下发受理返回 `dispatched` 并**保留**待播放上下文，由 `PlaylistManager` 在起播确认结算时回调协调器，只有 `landed`（确认起播）与 `superseded`（确认窗口被暂停/切歌/停止/新内容打断）才清除；`not-landed`（两轮未确认）保留，供用户重试。

采纳的设计取舍与边界：

- **不阻塞响应**：`playPendingContext` 立即返回「已下发」，确认结果走 `onLandingResult` 回调（复用 `setNewContentHook` 式的宿主接缝思路）。拒绝让「继续播放」最多等 18 秒。
- **语义改名**：`ResumePendingResult` / `PlaybackContext` 下发结果由 `succeeded` 改为 `dispatched`；`LandingResult` 表达 `landed` / `not-landed` / `superseded`。术语写入 `CONTEXT.md`。
- **重复继续**：确认窗口内同目标再次「继续播放」返回 `in-progress`，不下发、不回退目标原内容。
- **电台与单曲例外**：两者不启用起播确认，`dispatched` 即视为消费完成（受理后清除）；已写入规格数据契约。
- **登记先于下发**：`activeResumes` 在调用 `playPlaylist` 之前登记，覆盖「确认回调早于下发 await 返回」的极端时序。

实现与接线：`player/landing_failure.ts`（LandingResult）、`player/manager.ts`（回调登记与三态结算）、`playback_sync/switch_coordinator.ts`（消费状态机）、`playback_sync/host_deps.ts` 与 `main.ts`（第 9 个参数透传）、`handlers/playlist.ts` 与 `voicecmd/*`（对外 outcome 迁移）。

测试：`src/player/landing_result.test.ts`（5 项，假时钟覆盖 landed / not-landed / superseded / 电台例外 / cleanup 不结算）、`switch_coordinator.test.ts` 新增起播门控与登记时序用例、`switch_integration.test.ts` 用假时钟覆盖「确认成功才清除」。三次变异验证分别令「受理即清除」「不回调 landed」「登记晚于下发」变红，确认测试有鉴别力。

评审追加：`PlaylistManager.cleanup()`（插件卸载/热重载、设备分组变化）会经 `stopCheckTimer()` 结算为 `superseded`，从而把仍在确认窗口内的 pending 清掉——但那不是用户操作，用户明明刚点了继续，重载后却恢复不了。已在 `cleanup()` 摘掉待结算回调并加回归测试。此前的行为已由变异验证确认会变红。

注意：此前发现并删掉了一处死代码——原打算在 `handleLandingFailure` 再结算 `not-landed`，但起播确认总在 ≤18 秒结算，而外部极早停止路径在 ≥40 秒才触发，回调早已被消费，该分支不可达。

未覆盖：真机上弱网导致确认查询连续失败、以及确认窗口内设备离线再恢复的行为，仍需票据 03 真机验收。
## Comments

- 2026-09-21：真机验收前第五轮对抗性排查时发现。用探针复现：`playPlaylist` 返回 `succeeded`
  但设备实际未拉流时，`pending` 已被清除（`PROBE18 outcome=succeeded pendingAfter=CLEARED`）。
  因涉及跨模块返回值语义变更与响应时间权衡，按 issue tracker 约定登记为独立票据，
  不塞进正在收尾的评审整改。
