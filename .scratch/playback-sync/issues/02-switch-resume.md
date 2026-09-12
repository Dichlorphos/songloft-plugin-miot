# 切换设备播放上下文同步

Type: task
Status: ready-for-agent
Blocked by: 01

实现 spec.md 定义的独立设备切换同步、待播放上下文、revision、去重、消费和语音接入。设备组继续使用现有共享 PlaylistManager。

验收：切换静默且不覆盖活动上下文；继续等待同步并在成功后消费；失败保留；快速切换和用户选歌使旧任务失效；纯逻辑与宿主集成测试完成后再做真机验收。
