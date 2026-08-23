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

创建临时房间并返回 `roomId`、6 位 `pairingCode`、创建方 `deviceToken`、`expiresAt` 和 `joinUrl`。成功状态码为 `201`。单个来源每分钟最多创建 20 个房间。

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

### `GET /api/webrtc/config?roomId=<ROOM_ID>`

请求头使用 `Authorization: Bearer <DEVICE_TOKEN>`。授权设备可获取 `iceServers` 和 `negotiationTimeoutMs`；STUN、TURN 和超时分别由 `WEBRTC_STUN_URLS`、`WEBRTC_TURN_URLS`、`WEBRTC_TURN_USERNAME`、`WEBRTC_TURN_CREDENTIAL` 和 `WEBRTC_NEGOTIATION_TIMEOUT_MS` 配置。TURN URL 与凭据必须同时提供，协商超时允许 1000 至 30000 毫秒，默认 10000 毫秒。

### `POST /api/rooms/:roomId/images`

请求头使用 `Authorization: Bearer <DEVICE_TOKEN>`，JSON 请求体包含原始 `transferId` 和 Base64 编码的加密 `bytes`。加密会话完成双方验证后才能上传；服务端限制加密图片包大小。首次上传返回 `201`，相同发送设备以同一 `transferId` 重复上传相同密文返回 `200` 和稳定 `imageId`；冲突密文返回 `IMAGE_CONFLICT`。响应包含 `imageId`、`transferId`、密文字节数和 `duplicate`。

### `GET /api/rooms/:roomId/images/:imageId`

请求头使用 `Authorization: Bearer <DEVICE_TOKEN>`。接口返回当前房间内的加密图片字节，`Content-Type` 固定为 `application/octet-stream`。

### 错误响应

房间接口当前可能返回 `PAIRING_CODE_INVALID`、`ROOM_EXPIRED`、`ROOM_FULL`、`SESSION_UNAUTHORIZED` 和 `INTERNAL_ERROR`。图片接口还可能返回 `IMAGE_TYPE_UNSUPPORTED`、`IMAGE_TOO_LARGE`、`IMAGE_METADATA_INVALID`、`IMAGE_NOT_FOUND`、`IMAGE_CONFLICT` 和 `IMAGE_CAPACITY_EXCEEDED`。限流响应使用 `RATE_LIMITED`，HTTP 状态码为 `429`，并通过 `Retry-After` 响应头和 `retryAfterSeconds` 字段返回等待时间。

## 共享协议

`shared/protocol.ts` 定义以下主要内容：

- 房间状态：`waiting`、`paired`、`closing`。
- 客户端消息：密钥交换、验证确认、WebRTC Offer/Answer/ICE/Restart、密文回退、消息重试、会话关闭和心跳。
- 服务端消息：会话就绪、配对完成、设备在线状态、可信角色密钥交换、验证状态、可信角色 WebRTC 信令、密文投递、消息确认、心跳响应、会话关闭和错误。
- API 数据：创建房间响应、加入房间请求和响应、ICE 服务器配置、协商超时和加密图片临时标识。
- 限制常量：5 分钟配对和验证有效期、60 秒重连窗口、32 KiB SDP、2048 字符 ICE 候选、每轮 256 个 ICE 候选、96 KiB Base64URL 密文和 128 KiB WebSocket 帧。
- 图片格式：JPEG、PNG、WebP 和 GIF。

## 校验函数

- `isSupportedImageType`：判断 MIME 类型是否属于允许的图片集合。
- `validateText`：检查文字类型、空白内容和长度上限，返回结构化 API 错误。
- `validateEncryptedEnvelope`：严格校验版本、密钥代次、消息标识、规范 Base64URL nonce、GCM 密文和字段集合。
- `parseClientMessage`：严格解析密钥交换、验证、信令、密文回退和控制消息，拒绝额外字段。
- `validateImageUpload`：校验图片 MIME 类型和原始字节数。

## WebSocket 接口

### `GET /ws?roomId=<ROOM_ID>&deviceToken=<DEVICE_TOKEN>`

使用房间标识和设备令牌建立连接。鉴权失败时握手返回 `401`。连接成功后服务端立即发送 `session.ready`，其中包含当前设备标识、固定角色、房间状态、对端在线状态、验证状态、对端公钥交换记录和密文历史。

已实现的客户端消息包括 `key.exchange`、`verification.confirm`、`webrtc.offer`、`webrtc.answer`、`webrtc.ice`、`webrtc.restart`、`transfer.fallback`、`image.fallback`、`message.retry`、`session.close` 和 `ping`。服务端只向同房间对端定向转发密钥与信令，为事件注入可信发送角色，并要求双方验证完成后才接收密文回退。`image.fallback` 仅引用当前发送设备已经上传且 `transferId` 匹配的临时密文包，对端收到 `image.deliver` 后通过授权 HTTP 接口下载。相同发送设备和消息标识的相同密文只返回确认，冲突密文返回 `MESSAGE_CONFLICT`。`ping` 返回 `pong`。

设备连接和断开时，对端分别收到 `peer.online` 和 `peer.offline`。设备在 60 秒宽限期内使用原令牌重连时，`session.ready` 会恢复房间中的消息视图。任一设备发送 `session.close` 后，连接中的设备收到 `session.closed`，房间内存随即清理。

每个 WebSocket 连接一分钟允许处理 60 条客户端消息，单个入站帧上限为 16 KiB。超限消息返回 `error` 事件，其中错误码为 `RATE_LIMITED`，`retryAfterSeconds` 为剩余暂停时间。

## HTTP 安全响应头

所有 HTTP 响应包含 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`、受限的 `Permissions-Policy` 和限制同源资源的 `Content-Security-Policy`。

## 浏览器客户端

客户端首页提供创建房间和输入配对码两个入口。创建成功后，浏览器生成一次性邀请秘密并仅将其附加到二维码加入 URL 的 `#k=` Fragment；扫码页面在应用启动时消费并清除 Fragment。第二台设备连接后，两端交换一次性临时公钥。二维码流程验证公钥 HMAC 证明并自动确认，手动配对流程显示 12 位短验证码并等待双方确认。验证完成前文字、图片和发送控件保持禁用。

验证完成后，客户端创建 `awindow-transfer` 可靠有序 DataChannel。创建方固定发送 Offer 和重启信令，加入方固定发送 Answer，双方交换当前协商轮次的 ICE 候选。状态栏显示“正在建立直连”“设备直连”或“加密中转”；10 秒超时、连接失败和通道关闭会启用回退状态，创建方自动发起新协商。

文字 DataChannel 外层帧仅包含 `type: "transfer.encrypted"` 和严格校验的 `EncryptedEnvelope`。解密载荷包含文字或 ACK，文字正文和 ACK 目标均位于 AES-GCM 密文中。发送端等待端到端加密 ACK，5 秒后重试一次；第二次超时或直连不可用时发送相同 `transfer.fallback` 信封。`message.ack` 仅表示服务端已接受密文，接收端生成的加密 ACK 表示内容已认证。

图片开始与完成控制帧同样使用 `transfer.encrypted` 外层。开始载荷加密文件名、MIME 类型、原始大小、32 KiB 块数和 SHA-256 摘要。每个二进制块固定为 65584 字节：16 字节 UUID、4 字节大端块序号、12 字节 nonce、65536 字节填充明文对应的 AES-GCM 密文和 16 字节认证标签。发送端使用 512 KiB 高水位和 128 KiB 低水位控制 DataChannel 缓冲；接收端按控制帧顺序认证、重组和验证摘要。直连中断或 5 秒内缺少端到端 ACK 时，发送端将同一开始信封、全部同一密文块和同一完成信封打包上传；接收端复用现有分块和 `transferId` 去重，跨通道最多显示一次。

DataChannel 恢复为直连时，两端各自发送一次 `transfer.encrypted` 外层的加密 `resume` 载荷。载荷包含已确认接收的文字消息标识和图片传输标识，以及仍未完成图片的已接收块序号。接收方据此清理已确认的待发送文字和图片，并只对仍缺失的图片块重发密文块和完成信封，已到达的分块不会重复发送。恢复载荷中的消息标识和分块状态位于 AES-GCM 密文内，服务端不可见。

Vite 开发服务器将 `/api`、`/health` 和 `/ws` 代理到 `127.0.0.1:3001`。客户端会话凭据、邀请秘密、一次性 ECDH JWK、公钥、密钥代次和 nonce 状态保存在当前标签页的 `sessionStorage` 中，浏览器刷新后恢复加密会话。结束、失效或验证失败会销毁内存密钥引用并清理会话存储。
