# 系统架构

## 当前结构

```text
client/
  index.html
  src/main.ts
  src/transfer-client.ts
  src/styles.css
server/
  app.ts
  index.ts
  rooms/
    errors.ts
    room-repository.ts
    room-service.ts
    routes.ts
    types.ts
  realtime/
    websocket-gateway.ts
  security/
    rate-limiter.ts
shared/
  protocol.ts
  protocol.test.ts
```

`client` 是 Vite 浏览器入口，提供创建/加入首页、二维码配对页和响应式传输工作区。`TransferClient` 封装 HTTP、WebSocket、心跳、断线重连和图片读取。`server` 是 Fastify 服务入口，提供应用工厂、健康检查、房间 API 和 WebSocket 升级入口。`server/rooms` 维护内存房间仓库、配对业务、会话授权及生命周期清理。`server/realtime` 负责设备连接绑定、在线状态、文字和图片元数据投递、确认和历史恢复。`shared` 定义浏览器和服务端共同使用的协议类型、限制常量及基础校验。

## 房间生命周期

房间创建时生成 UUID 房间标识、6 位随机配对码和 256 位随机设备令牌。服务端仅保存配对码和设备令牌的 SHA-256 摘要。待配对房间在 5 分钟后清理，设备断线后的清理宽限期为 60 秒。房间关闭时同步清空设备、消息和图片内存。

## 实时连接

设备通过房间标识和设备令牌建立 WebSocket 连接。每个设备同时保留一个有效连接，重连会替换旧连接。服务端广播在线状态，按房间内存顺序保存文字消息，并使用客户端消息标识去重。连接建立时通过 `session.ready` 返回设备状态和当前会话消息视图。

## 图片传输

客户端先通过房间图片 API 上传 Base64 编码的图片内容，再发送 `image.send` 广播服务端返回的图片元数据。服务端验证设备令牌、MIME 类型、10 MB 单图上限和已存图片元数据，并将图片消息纳入现有确认、去重与历史恢复流程。

图片字节仅保存在所属房间的内存中，跨房间令牌无法读取。单进程图片总容量为 25 MB，房间关闭或过期清理时同步释放图片字节。

## 安全控制

`server/security` 提供按键隔离的内存滑动窗口限流器。同一来源在一分钟内累计 10 次无效配对后暂停 5 分钟；单个 WebSocket 连接一分钟允许 60 条消息，超限后暂停 60 秒。限流错误使用统一 `RATE_LIMITED` 响应并包含剩余等待秒数。

所有 HTTP 响应包含内容类型嗅探保护、点击劫持保护、来源策略和内容安全策略。用户文字和文件名在协议层作为数据保存，浏览器界面需要继续使用纯文本 DOM API 渲染。

## 构建流程

`npm run build` 先执行全项目 TypeScript 类型检查，再使用 `tsconfig.server.json` 将服务端和共享协议编译到 `dist/server` 与 `dist/shared`，最后由 Vite 将浏览器静态资源输出到 `dist/client`。开发模式通过 `tsx` 运行服务端，生产模式通过 `npm start` 运行 `dist/server/index.js`。生产部署由 Nginx 托管 `dist/client`，并将 `/api`、`/health` 和 `/ws` 转发至单个 Fastify 实例。

## 已实现边界

- Playwright 使用桌面 Chrome 和 iPhone 13 移动视口仿真验证首页、配对页、双设备工作区，以及真实文字和图片传输流程。
- WebRTC DataChannel 尚未进入实现，当前规格位于 `.monkeycode/specs/2026-07-19-webrtc-data-transfer/`。
