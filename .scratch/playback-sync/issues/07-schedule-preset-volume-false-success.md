# 定时任务预设音量失败时仍报告「音量 N」成功

Type: task
Status: needs-triage
Blocked by: 无

## 问题

`#476`（上游 `73c925b`）给定时播放加了「播放前预设音量」：`TaskExecutor.applyPresetVolume()` 在开播前把目标设备音量调到 `params.volume`。

该方法的失败策略是**有意为之**——注释明确写着「失败仅告警不阻断，用户更在意『歌先响起来』」：

- `setVolume` 返回 `false` → 只 `log.warn` 后 `return`；
- `setVolume` 抛异常 → `catch` 里只 `log.warn`；
- 两种情况都**继续开播**，这本身不是缺陷。

真正的问题是**结果文案失真**。任务成功文案由 `describeExtras()` 拼装，它直接读的是**请求参数**而非**实际结果**：

- `src/schedule/executor.ts` 的 `describeExtras(params, timerActive)` 中：
  `if (typeof p.volume === 'number' && p.volume >= 0 && p.volume <= 100) parts.push('音量 ${p.volume}')`
- 与 `applyStopTimer()` 的返回值 `timerActive` 不同，音量的实际生效结果**没有被回传**——`applyPresetVolume()` 返回 `void`。

于是当 `setVolume` 失败（设备离线、云端超时、权限不足等）时，任务仍会返回形如
`播放歌单「晚安」……（音量 20）成功` 的文案，**谎报音量已生效**。

## 影响

早餐、睡前等依赖「小音量播放」的场景里，用户以为已经压到 20，实际设备可能仍停在昨夜的大音量上开播——一次刺耳的意外，且从任务结果里看不出任何异常。

## 期望（待维护者确认，两种取向）

- **A（推荐，改动最小）**：`applyPresetVolume()` 记录实际结果并回传（如返回 `boolean`），`describeExtras()` 据此区分——成功才写「音量 N」，失败写「音量设置失败」或省略该项；播放仍不阻断。
- **B**：仅当 `volume` 参数存在但未能生效时，把任务结果标为「部分成功」，让用户明确知道音量的兜底没有落上。

两种都保持「不阻断播放」的既有取向，只修正**对外报告**与**实际状态**不一致的问题。

## 验收

- 单测：`setVolume` 返回 false 时，任务结果文案不得包含「音量 N」字样（或明确标注设置失败）。
- 单测：`setVolume` 抛异常时同上。
- 单测：`setVolume` 成功且 `fanOutSetVolume` 正常时，文案仍包含「音量 N」，行为不变。
- 回归：未传 `volume` 参数时，文案与既有行为完全一致。

## Comments

- 2026-09-21：`/code-review` 全局审核（Spec 轴）时发现。**该行为来自上游 `#476`，不是 fork 合并引入的**——`upstream/main` 的 `applyPresetVolume` 与调用点注释均为原样。因属上游既有缺陷而非本次合并残留，单独登记，不阻塞合并结果推送。
- 待定：取向 A 或 B 需要维护者拍板；`needs-triage`。
