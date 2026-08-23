# 项目文档

## 项目概览

AWindow 是一个 TypeScript 单体 Web 项目，目标是在两个设备的浏览器之间临时传输文字和图片。当前已实现临时房间、双设备角色、一次性浏览器密钥、二维码公钥认证、手动短验证码确认、授权 ICE 配置、WebRTC DataChannel 直连和重协商、加密文字确认重试与回退、加密图片分块直传、保留原 `transferId` 的 HTTP 密文图片回退和跨通道幂等，以及直连恢复时的恢复状态交换与缺失消息和图片分块重传。

## 文档索引

- `ARCHITECTURE.md`：当前代码结构和运行边界。
- `INTERFACES.md`：共享协议、类型和已实现 HTTP 接口。
- `DEVELOPER_GUIDE.md`：开发、测试和构建命令。

## 规格文档

- 基础传输需求、技术设计和实施任务位于 `.monkeycode/specs/2026-07-11-cross-device-transfer/`。
- WebRTC 直连与端到端加密需求、技术设计和实施任务位于 `.monkeycode/specs/2026-07-19-webrtc-data-transfer/`；加密会话、验证界面、服务端密文模型、信令、文字传输、图片直传、HTTP 密文回退、恢复状态交换与缺失分块重传，以及配套的单元、集成和浏览器 E2E 均已完成。
