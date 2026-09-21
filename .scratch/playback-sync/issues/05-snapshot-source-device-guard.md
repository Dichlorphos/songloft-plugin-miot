# 正常切换路径需校验快照来源设备

Type: task
Status: done
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

## Answer

已按 `grill-me` 澄清并以实现验证：

**核心不变量**：待播放上下文只能承载本次切换源设备的内容。快照按账号只存一条，同账号多台独立设备会互相覆盖，所以凡是把这条快照当成某台设备的上下文使用，都要先确认来源。

**判定**：同时比较 `source_device.account_id` 与 `device_id`（收进共享谓词 `isSnapshotFromDevice`）。

**三道来源校验，各守一个窗口**：

1. 协调器读完账号级快照后：来源不符 → 不采样、不写 pending，返回 `reason: 'source_mismatch'`。
2. `PlaybackRecorder.sampleOnSwitch` 读完当前快照后：来源不符 → 不采样、不写盘，返回 `reason: 'source_mismatch'`。这保护的不只是 pending——否则会拿源设备的物理位置去刷新别的设备的快照。
3. 写 pending 之前：最后复查一次，拦「前两道之后、落盘之前」的窗口。

**`stale` 与 `source_mismatch` 汇聚**：两者在协调器里都走「重读当前快照 → 只有仍来自源设备才采用 → 否则回退到本次切换开始时读到的那份源设备快照」这一条分支，仅日志区分。回退保证源设备自己的旧内容仍可排队，同时别的设备的内容永远进不了 pending。

**保留既有 pending**：来源不符等同于「本次没有可用的新上下文」，目标原有排队内容不动；清除只由「用户选择新内容」触发。

**边界**：`reason` 仅作内部诊断，不改 `/mina/last_selection` 的 HTTP 契约；不做按设备存多条快照的数据模型迁移（沿用 ADR-0002 取舍）。

**实现**：`snapshot_store.ts` 新增 `isSnapshotFromDevice`；`recorder.ts` 加前置校验与 `source_mismatch`；`switch_coordinator.ts` 加前置与落盘前校验、汇聚分支；`index.ts` 导出谓词。`main.ts` 无需改动——`SwitchSampleRequest.device_id` 本就是源设备，可直接作为期望来源。

**测试**：新增 5 例——recorder 层三例（来源不符不采样/不篡改别的设备、来源一致照常写回）；协调器层三例中的 (a) 初始来源不符不写 pending、(b) 采样期间被覆盖时回退源设备内容、(c) 采样依赖返回来源不符的快照时在落盘前拒绝写入。另有 1 例既有测试「同一目标连续选择」按其原意重写：它原先依赖「静态账号级快照 + 两个不同源设备」，在新不变量下不成立，改为一先发进入采样、再让 devX 覆盖账号级快照、后发再读。全部做变异验证：分别去掉 recorder 前置校验、协调器前置校验、协调器落盘前校验后，对应新测试确实变红。

**验证**：`npm test` 255 项通过、`npm run typecheck` 通过。

## Comments

- 2026-09-21：框架级需求审核时发现。该问题是快照模型「按账号一条观测」与「多台独立设备各自播放」之间未显式收口的边界；现有 `stale` 分支的保护不能覆盖正常路径，故登记为独立票据，状态 `needs-triage`。
- 2026-09-21：经 `grill-me` 四轮澄清后方案定形，按上述 Answer 实现并验证。真机验收票据 03 的 A1/A2、C1 受影响，须一并重测。