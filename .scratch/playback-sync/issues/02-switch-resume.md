# 切换设备播放上下文同步

Type: task
Status: done
Blocked by: 01

任务目标：基于任务 01 接入独立设备选择、待播放上下文和现有播放/语音控制流程。

需求与验收入口：[实现边界](../spec.md#实现边界)、[设备切换与待播放上下文](../spec.md#设备切换与待播放上下文)、[继续、恢复与失败处理](../spec.md#继续恢复与失败处理)、[验收](../spec.md#验收)中的切换、继续、并发和设备回归场景。代码基线见[完整需求规范](../spec.md#代码基线)。

## 交付边界

- 切换入口是设备选择接口本身，源设备取该请求开始时账号已记录的当前选中设备，再更新为目标设备。源设备不能在请求处理中读「更新后的当前选择」，否则永远得到目标设备而跳过同步。
- 待播放上下文存储由本任务交付，与任务 01 的播放快照存储分开。切换只写待播放上下文，并调用任务 01 的位置采样入口刷新快照。
- 「选择新歌单或新歌曲即清除 pending」的可靠信号在播放请求处理处，不在前端歌单选择处：前端切换歌单选择只改本地状态、不通知后端。清除必须发生在加载与起播之前。
- `resume` 与 `toggle` 的待播放上下文优先路径复用现有播放管理器的准备/下发分离能力，不新增切换 API 或最近播放入口。

## Comments

- 2026-09-13：已确认快照过期后，采样成功可创建新 revision；设备选择必须区分 pause/stop；前端测试路径修复与任务 01/02 纯逻辑、集成测试列为完成门槛。
- 2026-09-13：已确认目标播放中切换不打断活动上下文；`toggle`/`resume` 优先待播放上下文；下发后未知结果保留原上下文；选择新内容使旧同步任务失效。
- 2026-09-13：已确认下发结果使用 `succeeded`/`failed`/`unknown`；`unknown` 返回 `success:false` 与 `outcome:'unknown'`，不回滚、不自动重播、不清除待播放上下文。
- 2026-09-13：已确认设备选择接口的后台采样与待播放上下文同步失败不影响成功响应；`toggle`/`resume`/播放接口返回 `outcome`；纯逻辑测试优先使用 Node 内置 `node:test`。
- 2026-09-13：已确认源设备取切换前当前选择；跨账号不共享快照；pending 首次写入起算 30 分钟；目标离线仍保存 pending，选择新内容立即清除并使旧任务失效。

- 2026-09-19（框架复盘，已采纳）：切换入口确定为设备选择接口，源设备取请求开始时的当前选择再更新；原方案未指定该入口，而任务 01 只交付播放侧服务、接不到设备选择路径。
- 2026-09-19（框架复盘，已采纳）：「选择新歌单或新歌曲即清除 pending」改在播放请求处理处生效，先于加载与起播。前端歌单选择只改本地状态，不构成后端可观测信号。
- 2026-09-19（框架复盘，已采纳）：本任务交付待播放上下文存储，与任务 01 的播放快照存储分属两个模块与两个存储键。

- 2026-09-19：实现完成。交付：pending_store（按账号+目标设备存一条、深拷贝不可变副本、30 分钟 TTL、去重不刷新、revision 防旧任务回写）；switch_coordinator（切换读源设备→采样→写 pending，源/目标相同、无源、设备组都跳过；后台同步失败不影响接口成功）；host_deps（getPlayState 换算曲内位置、getById 取回歌曲、组判定、gracefulPlay 下发）；handlers 接线（/mina/last_selection 走切换、toggle 与显式 resume 优先消费 pending、PlaylistManager 内统一清除 pending）；账号删除同时清 pending。新增 31 个纯逻辑测试，总计 68 个通过。
- 2026-09-19：验收命令：npm test（68 通过）、npm run typecheck、node frontend/tests/run.mjs、npm run build 全部通过。
- 2026-09-19：补充宿主集成测试（switch_integration.test.ts，6 例）：用内存 fake 替换 songloft 与 MinaService，装配真实 ConfigManager/PlaylistManagerMap/PlaylistManager，覆盖「切换不发控制命令」「切换用物理位置刷新快照」「继续才下发 URL 且带 seek、成功后清除 pending」「取不到歌曲不下发且保留」「歌单为空在加载阶段失败且保留」「任一侧属设备组完全跳过同步」。
- 2026-09-19：为让集成测试可跑，新增 Node ESM 解析钩子（scripts/ts-resolve-hooks.mjs + register-ts-hooks.mjs），给旧模块的无扩展名相对导入补 .ts、并让裸 JSON 导入可加载；npm test 通过 --import 接入该钩子。player/manager 的 MinaService 改为 import type（仅作类型使用），剪掉测试时不需加载的 service→mina→miio→pako 依赖链。tsconfig.test.json 的 include 补上 src/types/*.d.ts，使宿主链的 pako 声明对测试可见。
- 2026-09-19：验收命令：npm test（75 通过，含 6 条宿主集成）、npm run typecheck、node frontend/tests/run.mjs、npm run build 全部通过。构建产物 hash 与改动前一致，确认 import type 与测试钩子不影响打包。
- 2026-09-19：两轴代码评审（固定点 8b9d6d1）后采纳整改。
  - **采样入口归一（两轴共同命中）**：任务 01 已暴露 PlaybackRecorder.sampleOnSwitch，但本任务在 switch_coordinator 里把「采样 + 2 秒超时 + revision 写入」又实现了一遍，且该入口在生产代码中从未被调用。现改为 coordinator 注入并调用 sampleOnSwitch，删除重复实现；SwitchSampleResult 增加可选 snapshot 以回传新 revision。新增 sample_entrypoint.test.ts 做防回归（含变异验证）。
  - **语音/AI resume 绕过 pending（Spec 硬要求缺口）**：VoiceEngine.executeResume 原先先判 hasPlaylist()，切到新设备后目标 manager 为空即播报「没有正在播放的内容」。现抽 oicecmd/resume_pending.ts，在 hasPlaylist 之前先消费 pending；pending 存在时无论 succeeded/failed/unknown 都不静默回退目标原上下文。
  - **标签集补齐（Standards 硬性）**：Status: done 原不在 triage-labels.md 的标签集内；按该文件「Edit the right-hand column to match whatever vocabulary you actually use」的约定补入 done，并注明它不代表真机验收已覆盖。
- 2026-09-19：处理上轮评审暂缓的两条 Spec 发现。
  - **outcome 契约补齐（成立，已修）**：规格第 70 行要求 	oggle、明确 resume 与实际播放接口返回 outcome，但 toggle 的普通暂停/恢复/重播分支与 /player/play 普通成功分支此前只返回 success/state。现四处统一补 outcome: 'succeeded'；新增 src/handlers/playlist_outcome.test.ts，用 SDK 真实 createRouter + 真实 HTTPRequest 驱动 handler（只替身 manager/mina/config），并做变异验证（移除 outcome 即变红）。
  - **「新内容清除 pending 未覆盖单曲直推」（复核为误报，未改代码）**：语音单曲直推与歌手歌单均经 playWithSongs（已挂 newContentHook）；eplayCurrent 重推的是**当前**歌曲而非「新歌单或新歌曲」，按规格第 46/71 行不该清除 pending。
- 2026-09-19：spec 状态同步为 done（两个子票据均已完成实现与自动化验证）。真机验收仍未覆盖，done 不代表已通过真机。


- 2026-09-19（两轴评审后采纳）：设备选择接口先同步提交当前选择，提交成功后再后台采样与写 pending；该响应契约经维护者确认，spec 第 57/70 行同步改写。未采用“选择写入失败仍返回成功”，因为前端在该响应后立即刷新状态，会读到旧设备。
- 2026-09-19（两轴评审后采纳）：目标设备复合键统一复用 `pendingKey`；每次设备选择也递增同步代际，避免同一目标连续选择时先发任务的晚到 pending 覆盖后发任务。

- 2026-09-19：真机验收拆为独立票据 [03-manual-acceptance.md](03-manual-acceptance.md)，状态 `ready-for-human`，作为播放同步相关版本的发布门禁。本票据的 `done` 仍只代表实现与自动化验证完成；真机未通过不得解除门禁，也不得据此宣称验收完成。

- 2026-09-21（真机验收前加严评审，已采纳）：本轮两轴评审后集中整改，全部带回归测试。
  - **跨账号切换**：`cross_account` 原先只在 reason 联合里声明、从不产出——后端拿目标账号读「源设备」，从 A 切到 B 会解析成 B 自己的旧选择。现由前端上报 `from_account_id`，协调器据此识别跨账号：只更新选择、不创建同步任务。
  - **设备组判定失败**：`isDeviceInGroup` 原先把读配置异常吞成 `false`（等于宣称「这是独立设备」），现改为抛出，协调器按「无法排除设备组」保守跳过。
  - **pending 读故障**：原先 `loadEnvelope` 把存储异常也当成「没有数据」，`tryResumePending` 因此返回 `none`，调用方会静默回退目标原上下文并可能报成功。现区分「没有」与「读不了」，后者如实报 `failed`。
  - **pending 内层快照**：原先只校验 `snapshot` 是对象，坏副本会一路带到恢复路径；现复用 `isValidSnapshot` 全字段校验，并要求副本与条目同账号。
  - **坏数据诊断**：单条坏数据原先静默丢弃，现按 spec 第 74 行逐条记录诊断日志（含来源前缀与丢弃条数）。
  - **存储读故障下的写入**：原先会按空信封继续写，把整封信封（含其它账号）覆盖掉；现改为写入失败且不落盘。
  - **快照出口顺序**：出口写入原先不携带任何顺序信息，迟到的旧出口可能盖掉更新的状态；现由 recorder 在出口处同步递增序号，存储拒绝更小序号的迟到写入。
  - **信封机制重复**：两个 store 逐行同形的信封读写抽到 `src/playback_sync/envelope_store.ts`，各自只保留键、schema 与条目校验。
  - **继续播放入口重复**：三条路（网页 toggle、网页 resume、语音/AI resume）各自重复的「取协调器 + 分支」收进 `resume_pending.ts` 的 `resumePendingIfAvailable` 与 playlist handler 的 `respondWithPendingIfAny`。
  - **`playPendingContext` 类型**：原先 `song: any` + `gracefulPlay` 可选能力探测，现改用 `LoadedSong`/`PlayMode` 并直接调用真实公开方法。
  - **重启恢复职责**：判定规则从 `manager.ts` 的异步流程抽到 `src/player/reload_restore_decision.ts` 纯函数，每条规则可直接喂输入验证。
  - 验证：`npm test` 227 项通过、`npm run typecheck`、`node frontend/tests/run.mjs`、`npm run build`（entryHash `3747e19a…`）。

- 2026-09-21（真机验收前第三轮对抗性排查，已采纳）：用可执行探针逐条验证并发与失败路径，发现并修掉 3 个自动化测试此前未覆盖的真实缺陷。
  - **并发「继续播放」会双重下发**：`tryResumePending` 原先没有任何互斥，两路并发（用户快速连点，或网页 `toggle` 与语音 resume 同时到达）会各自读到同一条 pending、各自下发一次播放。现按「账号 + 目标设备」串行消费；后到的一路返回 `none`，由调用方走正常回退。
  - **消费期间被作废仍会按旧上下文下发**：`clearPending` 只删存储里的 pending、递增代际，但已经读过 pending、正在加载歌曲的那一路手里仍握着旧快照。原先只有「写 pending」侧复查代际，「消费 pending」侧没有。现于下发前复查代际，被作废时返回 `none` 而不是把旧上下文推下去。
  - **`suppressNewContentHook` 是 manager 级布尔量，会误抑制并发请求**：`gracefulPlay` 在途期间打开该标志，任何**其它**并发请求（用户在别处点了新歌单、语音点了新歌）的 `clearPending` 都被一起抑制——新内容已经开始播，旧 pending 却还留在存储里，之后一次「继续播放」会把旧上下文又推出来。现改为逐次调用显式传参（`playWithSongs(..., { consumingPending: true })`），不再有这个共享状态。
  - 验证：`npm test` 234 项通过、`npm run typecheck`。新增 `src/player/new_content_suppression.test.ts`（4 项）；全部 5 条关键改动做过变异验证，回滚实现后对应测试确实变红（其中两条首版测试是假绿，已改成走真正会触发抑制的电台分支）。
