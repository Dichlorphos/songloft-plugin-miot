# 切换设备续播

Type: task
Status: ready-for-agent
Blocked by: 01

新增切换设备接口和服务方法。切换设备只返回最近快照供界面显示，不自动播放；用户点击播放后，依据快照重新生成 URL 并带 seek 位置起播。校验歌曲仍存在，失败时回退到歌单进度。

验收：切换设备后不会自动出声；界面显示最新歌曲和位置；用户点击播放后位置误差不超过 5 秒；URL 过期时可重建；目标设备离线不影响源设备。

## Progress
- 2026-09-12：新增 GET /player/recent-snapshot 与 POST /player/play-recent，切换读取不自动播放，播放时重建 URL 并带快照位置。

