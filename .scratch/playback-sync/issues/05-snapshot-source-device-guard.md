# 正常切换路径需校验快照来源设备

Type: task
Status: needs-triage
Blocked by: 01, 02

## 问题

播放快照按账号只存一条。同一账号下多台独立设备各自播放时，后一次出口观测会覆盖前一次，`source_device` 只记录最后写入者。

正常切换路径（非 `stale` 分支）目前直接把账号级快照写成目标设备的待播放上下文，没有先校验 `snapshot.source_device.device_id` 是否等于本次切换的源设备：

- `src/playback_sync/switch_coordinator.ts` 的 `runDeviceSelected` 读取 `snapshotStore.read(accountId)` 后直接采样/写 pending；
- 只有采样返回 `stale` 的补偿分支 `readFreshSnapshotForSource` 会校验来源设备；
- 现有回归测试「采样被判 stale 但更新的是别的源设备时，不得张冠李戴」只锁住了 `stale` 分支。

因此当同账号另一台独立设备最近写过快照时，从 A 切到 B 可能把 C 的内容排进 B 的待播放上下文。

## 期望

正常切换路径在采样前与采样后、写 pending 前都必须确认快照来源设备等于本次切换的源设备：

- 来源不一致时不要写错误的 pending；按「无可用快照」处理，目标保留原上下文；
- 采样失败但仍沿用旧快照时同样适用；
- 设备组、跨账号、源与目标相同的既有跳过规则不变。

## 验收

- 纯逻辑测试：同账号下 devC 最后写入快照、本次从 devA 切到 devB，不得生成指向 devC 内容的 pending。
- 纯逻辑测试：来源一致时行为不变，仍正常写 pending。
- 集成测试：覆盖「非 stale 路径读到别的设备快照」这一分支。
- 真机验收票据 03 的 A1/A2、C1 受影响，修复后须一并重测。

## Comments

- 2026-09-21：框架级需求审核时发现。该问题是快照模型「按账号一条观测」与「多台独立设备各自播放」之间未显式收口的边界；现有 `stale` 分支的保护不能覆盖正常路径，故登记为独立票据，状态 `needs-triage`。