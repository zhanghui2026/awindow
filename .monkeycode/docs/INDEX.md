# 项目文档

## 项目概览

AWindow 是一个 TypeScript 单体 Web 项目，目标是在两个设备的浏览器之间临时传输文字和图片。当前服务端已实现临时房间、双设备配对、实时文字与图片元数据投递、会话恢复，以及带令牌鉴权的图片内存存储。

## 文档索引

- `ARCHITECTURE.md`：当前代码结构和运行边界。
- `INTERFACES.md`：共享协议、类型和已实现 HTTP 接口。
- `DEVELOPER_GUIDE.md`：开发、测试和构建命令。

## 规格文档

- 基础传输需求、技术设计和实施任务位于 `.monkeycode/specs/2026-07-11-cross-device-transfer/`。
- WebRTC 直连传输需求和技术设计位于 `.monkeycode/specs/2026-07-19-webrtc-data-transfer/`，当前处于设计阶段。
