# 系统架构

## 当前结构

```text
client/
  index.html
  src/crypto-session.ts
  src/main.ts
  src/peer-transport.ts
  src/transfer-protocol.ts
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
  webrtc/
    config.ts
shared/
  protocol.ts
  protocol.test.ts
```

`client` 是 Vite 浏览器入口，提供创建/加入首页、二维码配对页、加密会话状态和响应式传输工作区。`TransferClient` 封装 HTTP、WebSocket、首消息鉴权、心跳、断线重连、ICE 配置获取和加密图片字节回退。`CryptoSession` 实现一次性 P-256 ECDH、HKDF-SHA-256、方向独立 AES-256-GCM 密钥、邀请秘密公钥证明、64 位会话密钥指纹派生、填充、重放保护和当前标签页恢复。`PeerTransport` 实现固定角色 Offer/Answer、ICE 候选、可靠有序 DataChannel、10 秒协商超时、创建方自动重新协商和 DataChannel 背压等待。`TransferProtocol` 负责加密文字确认重试，加密图片元数据、固定分块、重组和摘要验证，以及直连恢复时的恢复状态交换、已确认消息清理和缺失图片分块重传。客户端创建房间时生成邀请秘密，二维码只在加入 URL Fragment 中携带秘密；扫码加入自动认证双方临时公钥，配对码加入在双方密钥交换完成后自动建立加密会话。`server` 是 Fastify 服务入口，提供应用工厂、健康检查、房间 API、授权 ICE 配置和 WebSocket 升级入口。`server/rooms` 维护内存房间仓库、设备角色、加密验证状态、密文历史、加密图片字节及生命周期清理。`server/realtime` 负责设备连接绑定、密钥交换、自动验证、WebRTC 信令、密文回退和历史恢复。`shared` 定义浏览器和服务端共同使用的严格协议类型、限制常量及运行时校验。

## 房间生命周期

房间创建时生成 UUID 房间标识、6 位随机配对码和 256 位随机设备令牌。服务端仅保存配对码和设备令牌的 SHA-256 摘要。待配对房间在 5 分钟后清理，设备断线后的清理宽限期为 60 秒。房间关闭时同步清空设备、消息和图片内存。

## 实时连接

设备通过房间标识和设备令牌建立 WebSocket 连接：握手 URL 不携带凭据，连接打开后客户端必须立即发送 `session.auth` 首消息完成鉴权，失败或超时以关闭码 `4401` 拒绝。创建方与加入方角色在设备会话中固定保存，每个设备同时保留一个有效连接，重连会替换旧连接。服务端定向转发临时公钥、验证状态及 WebRTC Offer、Answer 和 ICE 候选；创建方固定发起协商，ICE 候选按协商轮次限制为 256 个。连接建立时通过 `session.ready` 返回设备角色、验证状态、对端公钥和当前密文历史。

验证完成后，客户端使用设备令牌从 `GET /api/webrtc/config` 获取当前部署的 STUN/TURN 配置。创建方建立名为 `awindow-transfer` 的可靠有序 DataChannel 并发起 Offer，加入方响应 Answer；协商超时或连接失败时进入加密中转状态，创建方按新协商标识重试。WebSocket 恢复和页面刷新会重建 PeerConnection，房间结束、失效或页面离开时关闭 DataChannel 和 PeerConnection。

文字发送时，客户端将文字 JSON 按桶填充并生成 AES-GCM 加密信封。直连路径发送受限的 `transfer.encrypted` JSON 帧；接收方认证、解密和渲染后返回独立加密 ACK。5 秒内缺少端到端 ACK 时重发同一信封一次，第二次超时或通道关闭时通过 `transfer.fallback` 发送同一信封。接收端按房间内的发送角色和消息标识统一去重，刷新时从服务端密文历史恢复回退文字。

## 图片传输

直连图片先在浏览器计算原始内容 SHA-256，并将文件名、MIME 类型、大小、块数和摘要放入加密元数据。图片按 32 KiB 原始内容切分，每块填充到 64 KiB 后独立执行 AES-GCM 加密；二进制帧使用 16 字节传输 UUID、4 字节块序号和 12 字节 nonce 固定头。发送缓冲达到 512 KiB 时暂停，降至 128 KiB 后继续。接收端串行认证并重组全部分块，只有大小、块数和摘要均匹配时才显示图片。每端同时只处理一张未完成图片，使页面内存受 10 MB 单图限制约束。

HTTP 图片回退将同一加密元数据、固定密文块和完成信封封装为不透明密文包。直连中断或端到端确认超时后，发送端使用原 `transferId` 上传密文包并通过 WebSocket 发送临时 `imageId`；接收端授权下载后复用直连接收队列补齐分块、验证摘要并统一去重。服务端按房间、发送设备和 `transferId` 幂等保存，只记录临时图片标识、传输标识、发送设备内部标识、密文字节和创建时间。

## 连接恢复

DataChannel 恢复为直连时，两端各自发送一次加密 `resume` 载荷，其中包含已确认接收的文字消息标识和图片传输标识，以及仍未完成图片的已接收块序号。接收方据此清理已确认的待发送文字和图片，并对仍未完成的图片仅重传缺失的密文块和完成信封，避免重复发送已到达的分块。恢复载荷同样封装在端到端加密信封中，服务端无法读取消息标识或分块状态。发送端在直连中断或转入回退状态时会将全部待发送文字和图片改由密文回退投递。

加密图片字节仅保存在所属房间的内存中，跨房间令牌无法读取。单进程图片总容量为 25 MB，房间关闭或过期清理时同步释放图片字节。

## 安全控制

`server/security` 提供按键隔离的内存滑动窗口限流器。同一来源在一分钟内累计 10 次无效配对后暂停 5 分钟；单个 WebSocket 连接一分钟允许 60 条消息，超限后暂停 60 秒。限流错误使用统一 `RATE_LIMITED` 响应并包含剩余等待秒数。

所有 HTTP 响应包含内容类型嗅探保护、点击劫持保护、来源策略和内容安全策略。用户文字和文件名在协议层作为数据保存，浏览器界面需要继续使用纯文本 DOM API 渲染。

## 构建流程

`npm run build` 先执行全项目 TypeScript 类型检查，再使用 `tsconfig.server.json` 将服务端和共享协议编译到 `dist/server` 与 `dist/shared`，最后由 Vite 将浏览器静态资源输出到 `dist/client`。开发模式通过 `tsx` 运行服务端，生产模式通过 `npm start` 运行 `dist/server/index.js`。生产部署由 Nginx 托管 `dist/client`，并将 `/api`、`/health` 和 `/ws` 转发至单个 Fastify 实例。

## 已实现边界

- Playwright 使用桌面 Chrome 和 iPhone 13 移动视口仿真验证首页、配对页、双设备工作区，以及真实文字和图片传输流程。
- 浏览器密码学会话、二维码 Fragment、密钥验证界面、共享密文协议、服务端验证状态、WebRTC 信令转发、加密文字传输、加密图片直传、HTTP 密文回退和直连恢复的状态交换与缺失分块重传均已完成，`.monkeycode/specs/2026-07-19-webrtc-data-transfer/` 的任务 6 全部落地。
