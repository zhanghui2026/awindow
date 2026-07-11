# 接口文档

## HTTP 接口

### `GET /health`

返回服务存活状态：

```json
{
  "status": "ok"
}
```

### `POST /api/rooms`

创建临时房间并返回 `roomId`、6 位 `pairingCode`、创建方 `deviceToken`、`expiresAt` 和 `joinUrl`。成功状态码为 `201`。

### `POST /api/rooms/join`

请求体：

```json
{
  "pairingCode": "ABC234"
}
```

使用有效配对码加入房间并返回 `roomId`、加入方 `deviceToken` 和 `paired` 状态。无效、过期或已满房间返回结构化错误。

### `DELETE /api/rooms/:roomId`

请求头使用 `Authorization: Bearer <DEVICE_TOKEN>`。授权设备可关闭房间，成功状态码为 `204`。

### `POST /api/rooms/:roomId/images`

请求头使用 `Authorization: Bearer <DEVICE_TOKEN>`，JSON 请求体包含 `fileName`、`mimeType` 和 Base64 编码的 `bytes`。接口接受 JPEG、PNG、WebP 和 GIF，单图原始内容上限为 10 MB。成功状态码为 `201`，响应包含 `imageId`、文件名、MIME 类型和原始字节数。

### `GET /api/rooms/:roomId/images/:imageId`

请求头使用 `Authorization: Bearer <DEVICE_TOKEN>`。接口返回当前房间内的原始图片字节，并设置对应的 `Content-Type` 和内联文件名。

### 错误响应

房间接口当前可能返回 `PAIRING_CODE_INVALID`、`ROOM_EXPIRED`、`ROOM_FULL`、`SESSION_UNAUTHORIZED` 和 `INTERNAL_ERROR`。图片接口还可能返回 `IMAGE_TYPE_UNSUPPORTED`、`IMAGE_TOO_LARGE`、`IMAGE_NOT_FOUND` 和 `IMAGE_CAPACITY_EXCEEDED`。限流响应使用 `RATE_LIMITED`，HTTP 状态码为 `429`，并通过 `retryAfterSeconds` 返回等待时间。

## 共享协议

`shared/protocol.ts` 定义以下主要内容：

- 房间状态：`waiting`、`paired`、`closing`。
- 客户端消息：文字发送、图片发送、消息重试、会话关闭和心跳。
- 服务端消息：会话就绪、配对完成、设备在线状态、消息投递、消息确认、心跳响应、会话关闭和错误。
- API 数据：创建房间响应、加入房间请求和响应、图片元数据。
- 限制常量：5 分钟配对有效期、60 秒重连窗口、10000 字符文字上限和 10 MB 图片上限。
- 图片格式：JPEG、PNG、WebP 和 GIF。

## 校验函数

- `isSupportedImageType`：判断 MIME 类型是否属于允许的图片集合。
- `validateText`：检查文字类型、空白内容和长度上限，返回结构化 API 错误。
- `parseClientMessage`：解析并校验客户端 WebSocket 消息。
- `validateImageUpload`：校验图片 MIME 类型和原始字节数。

## WebSocket 接口

### `GET /ws?roomId=<ROOM_ID>&deviceToken=<DEVICE_TOKEN>`

使用房间标识和设备令牌建立连接。鉴权失败时握手返回 `401`。连接成功后服务端立即发送 `session.ready`，其中包含当前设备标识、房间状态、对端在线状态和会话消息。

已实现的客户端消息包括 `text.send`、`image.send`、`message.retry`、`session.close` 和 `ping`。文字或图片元数据首次提交会向发送方返回 `message.ack`，并向对端发送 `message.deliver`；相同 `clientMessageId` 的重复提交只返回确认。图片广播要求 `imageId` 已通过当前房间的图片 API 存储且元数据完全一致。`ping` 返回 `pong`。

设备连接和断开时，对端分别收到 `peer.online` 和 `peer.offline`。设备在 60 秒宽限期内使用原令牌重连时，`session.ready` 会恢复房间中的消息视图。任一设备发送 `session.close` 后，连接中的设备收到 `session.closed`，房间内存随即清理。

每个 WebSocket 连接一分钟允许处理 60 条客户端消息。超限消息返回 `error` 事件，其中错误码为 `RATE_LIMITED`，`retryAfterSeconds` 为剩余暂停时间。

## HTTP 安全响应头

所有 HTTP 响应包含 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer` 和限制同源资源的 `Content-Security-Policy`。

## 浏览器客户端

客户端首页提供创建房间和输入配对码两个入口。创建成功后显示二维码、配对码和 5 分钟倒计时；第二台设备连接后进入单工作区传输页面。传输页面支持文字、图片预览与上传、图片查看/下载、复制文字、连接状态、自动重连和结束会话。

Vite 开发服务器将 `/api`、`/health` 和 `/ws` 代理到 `127.0.0.1:3001`。客户端会话凭据保存在当前标签页的 `sessionStorage` 中，浏览器刷新后尝试恢复会话。
