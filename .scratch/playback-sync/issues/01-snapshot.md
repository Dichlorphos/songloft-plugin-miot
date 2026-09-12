# 建立最近播放快照

Type: task
Status: needs-info

实现 PlaybackSyncService 的快照模型、持久化和过期判断。复用 ConfigManager 持久化接口，记录歌曲身份、索引、曲内位置、倍速和更新时间。

验收：插件重启后可读取；unknown/超时不会覆盖有效快照；快照超过 30 分钟按过期处理。

## Progress

- 2026-09-13：试做实现已还原，当前代码未包含 `PlaybackSnapshot`、持久化接口或过期判断。
- 当前仅完成需求整理；实现和验证均待进行。
