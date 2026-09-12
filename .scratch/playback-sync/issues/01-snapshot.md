# 建立最近播放快照

Type: task
Status: ready-for-agent

实现 PlaybackSyncService 的快照模型、持久化和过期判断。复用 ConfigManager 持久化接口，记录歌曲身份、索引、曲内位置、倍速和更新时间。

验收：插件重启后可读取；unknown/超时不会覆盖有效快照；快照超过 30 分钟按过期处理。

## Progress
- 2026-09-12：已完成 PlaybackSnapshot 类型、ConfigManager 持久化接口、30 分钟过期判断及状态解析流程接入。
- 下一步：补充验证并继续实现设备切换续播票据 02。

