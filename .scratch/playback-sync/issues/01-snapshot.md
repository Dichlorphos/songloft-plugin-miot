# 建立账号级最新播放快照

Type: task
Status: ready-for-agent

任务目标：建立账号级最新播放快照的采集、持久化与生命周期管理，供任务 02 使用。

需求与验收入口：[快照范围与生命周期](../spec.md#快照范围与生命周期)、[数据契约](../spec.md#数据契约)、[验收](../spec.md#验收)中的快照相关场景。代码基线见[完整需求规范](../spec.md#代码基线)。

## Comments

- 2026-09-13：已确认快照使用账号内单调递增整数 `revision`；位置通过 `position_available` 显式表示。电台纳入快照但位置固定为 0，外部 URL、单曲直推和外部播放排除。
- 2026-09-13：同一账号与目标设备只保留最新待播放上下文；账号删除时清理快照、待播放上下文和 revision 计数。
- 2026-09-13：已确认 `source_device` 使用 `{ account_id, device_id }`；电台使用 `content_type=radio` 与 `radio_id`，正式歌单使用 `content_type=playlist` 与 `playlist_id`；同步数据使用 `playback_sync_v1` 专用信封。
- 2026-09-13：已确认待播放上下文保存完整不可变副本；设备组播放不更新跨设备快照；所有插件主动状态变更统一采集，暂停升级停止时按 `stopped` 保存。
