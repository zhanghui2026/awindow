# AWindow

AWindow 是一个无需注册和登录的双设备临时传输工具。用户可以通过二维码或 6 位配对码连接电脑、手机或平板，并在浏览器中双向传输文字和图片。

房间、消息、图片和连接状态只保存在服务进程内存中。会话结束、房间过期或服务重启后，相关数据会被清理。

## 功能特性

- 二维码和 6 位配对码连接设备
- 每个房间最多连接两台设备
- 双向实时文字传输与一键复制
- JPEG、PNG、WebP、GIF 图片传输
- 图片预览、原图查看和下载
- 单张图片最大 10 MB
- 消息列表区分发送方，同一方 2 分钟内的连续消息自动合并
- 最多保留最近 200 条消息，超出后自动清理最旧消息
- 一次性 ECDH 密钥协商与端到端 AES-GCM 加密，密钥交换完成后自动建立会话
- 加密建立后面板显示 64 位会话密钥指纹，两侧一致可用于人工比对确认无中间人
- 设备令牌通过 WebSocket 首条 `session.auth` 消息提交，避免出现在连接 URL 与访问日志中
- WebRTC DataChannel 直连优先，WebSocket/HTTP 密文自动回退
- 跨直连与回退通道统一去重
- 60 秒断线重连和会话消息恢复
- 5 分钟待配对有效期
- 房间数据仅保存在进程内存
- 桌面与移动浏览器响应式界面
- 配对请求和 WebSocket 消息限流
- 二维码邀请仍校验邀请秘密对应的公钥证明

## 技术栈

- TypeScript
- Fastify
- WebSocket (`ws`)
- Vite
- QRCode
- Vitest
- Playwright

## 项目结构

```text
client/                  浏览器客户端
  index.html
  src/
server/                  Fastify 与 WebSocket 服务
  realtime/              实时连接与消息投递
  rooms/                 房间、消息和图片内存仓库
  security/              内存限流器
shared/                  前后端共享协议和校验
tests/e2e/               Playwright 端到端测试
.monkeycode/docs/        项目架构和接口文档
.monkeycode/specs/       需求、设计和实施任务
```

## 环境要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- 生产环境需要支持 HTTPS 和 WebSocket 的反向代理

安装项目依赖：

```bash
npm install
```

## 本地开发

后端默认监听 `127.0.0.1:3001`。在第一个终端启动 Fastify：

```bash
npm run dev
```

在第二个终端启动 Vite：

```bash
npm exec vite -- --host 0.0.0.0 --port 5173
```

访问：

```text
http://localhost:5173
```

Vite 会把 `/api`、`/health` 和 `/ws` 代理到 `127.0.0.1:3001`。

## 使用方法

### 创建房间

1. 打开 AWindow 首页。
2. 点击“创建传输房间”。
3. 页面会显示二维码、6 位配对码和剩余有效时间。
4. 保持当前页面打开，等待另一台设备加入。

### 加入房间

另一台设备可以使用以下任一方式加入：

- 使用相机扫描创建方页面上的二维码。
- 打开 AWindow 首页，输入创建方提供的 6 位配对码，然后点击“加入”。

第二台设备加入后，两端会自动进入传输工作区。

### 发送文字

1. 在底部输入框填写文字。
2. 点击发送按钮，或按 Enter 发送。
3. 使用 Shift + Enter 输入换行。
4. 接收方可以点击复制按钮复制完整文字。

单条文字最多 10,000 个字符，纯空白内容不会发送。消息列表最多保留最近 200 条消息；发送方区分「我」和「对方」两侧显示，同一方 2 分钟内的连续消息会合并为紧凑的一组。

### 发送图片

1. 点击输入区域左侧的图片按钮。
2. 选择 JPEG、PNG、WebP 或 GIF 图片。
3. 确认文件名、大小和预览。
4. 点击发送按钮。

单张图片最大 10 MB。接收方可以查看原图或下载图片。

### 断线恢复与结束会话

- 浏览器连接中断后，客户端会自动尝试重连。
- 两台设备均离线后，房间保留 60 秒重连窗口。
- 点击“结束会话”会关闭房间并清理服务端内存数据。
- 待配对房间在创建 5 分钟后自动过期。

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3001` | Fastify 服务端口 |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | 二维码和加入链接使用的公网基础地址 |
| `TRUST_PROXY` | `false` | 是否信任反向代理传递的客户端地址；仅在受控代理后设置为 `true` |
| `WEBRTC_STUN_URLS` | 空 | 逗号分隔的 `stun:` 或 `stuns:` URL |
| `WEBRTC_TURN_URLS` | 空 | 逗号分隔的 `turn:` 或 `turns:` URL |
| `WEBRTC_TURN_USERNAME` | 空 | TURN 用户名，配置 TURN URL 时必填 |
| `WEBRTC_TURN_CREDENTIAL` | 空 | TURN 凭据，配置 TURN URL 时必填 |
| `WEBRTC_NEGOTIATION_TIMEOUT_MS` | `10000` | WebRTC 协商超时，范围 1000 至 30000 毫秒 |

生产环境必须把 `PUBLIC_BASE_URL` 设置为用户实际访问的 HTTPS 地址：

```bash
export PORT=3001
export PUBLIC_BASE_URL=https://transfer.example.com
export TRUST_PROXY=true
npm start
```

## 生产部署

推荐使用单个 Node.js 服务实例，并由 Nginx 提供 HTTPS、静态文件和同源反向代理。房间数据保存在进程内存中，多实例部署会导致房间状态分散。

### 1. 构建应用

```bash
npm run build
```

构建产物位于：

```text
dist/client          前端静态资源
dist/server          编译后的服务端
dist/shared          服务端使用的共享协议
```

### 2. 启动后端

```bash
export PORT=3001
export PUBLIC_BASE_URL=https://transfer.example.com
export TRUST_PROXY=true
npm start
```

后端仅监听 `127.0.0.1`，适合由同一主机上的 Nginx 转发。

### 3. 配置 Nginx

下面的配置负责：

- 托管 Vite 构建产物
- 将 `/api` 和 `/health` 转发到 Fastify
- 将 `/ws` 升级为 WebSocket
- 为单页应用提供路由回退

```nginx
server {
    listen 80;
    server_name transfer.example.com;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name transfer.example.com;

    ssl_certificate /etc/letsencrypt/live/transfer.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/transfer.example.com/privkey.pem;

    root /opt/awindow/dist/client;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location = /health {
        proxy_pass http://127.0.0.1:3001/health;
        proxy_set_header Host $host;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 75s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

将示例中的域名、证书路径和项目目录替换为实际值。完成配置后检查：

```bash
curl https://transfer.example.com/health
```

预期响应：

```json
{"status":"ok"}
```

### 4. 使用 systemd 保持服务运行

创建 `/etc/systemd/system/awindow.service`：

```ini
[Unit]
Description=AWindow transfer service
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/awindow
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=PUBLIC_BASE_URL=https://transfer.example.com
Environment=TRUST_PROXY=true
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

加载并启动服务：

```bash
systemctl daemon-reload
systemctl start awindow
systemctl status awindow
```

生产部署建议使用 Node.js 20+，并确认 `npm` 的实际路径与 `ExecStart` 一致。

## 测试与质量检查

运行 TypeScript 类型检查：

```bash
npm run lint
```

运行 Vitest 单元与集成测试：

```bash
npm test
```

安装 Playwright Chromium 后运行桌面与移动 E2E：

```bash
npx playwright install chromium
npm run test:e2e
```

执行生产构建：

```bash
npm run build
```

## 数据与安全说明

- 设备令牌和配对码在服务端以 SHA-256 摘要存储。
- 设备令牌通过 WebSocket 连接后的首条 `session.auth` 消息提交，验证失败立即断开，令牌不出现在连接 URL 与访问日志中。
- 密钥指纹由双方共享密钥派生，仅用于人工比对确认；两侧显示一致即代表端到端密钥相同。
- 文字、图片内容、文件名和 MIME 类型仅在已验证的两个浏览器端解密。
- 直连与回退通道传输相同的端到端加密内容，并共享传输标识去重。
- 房间、文字和图片不会写入数据库或磁盘。
- 单个进程最多保存 25 MB 图片数据。
- 同一来源一分钟内累计 10 次无效配对后暂停 5 分钟。
- 单个 WebSocket 连接一分钟允许 60 条客户端消息。
- 所有 HTTP 响应包含基础安全响应头。
- 生产环境必须使用 HTTPS 和安全 WebSocket。

## 资源需求

| 场景 | 建议内存 | 建议磁盘 |
|---|---:|---:|
| 少量使用 | 256 MB | 300 MB |
| 推荐生产配置 | 512 MB | 500 MB |
| 本地开发 | 1 GB | 500 MB |
| 运行 Playwright E2E | 1–2 GB | 1 GB |

推荐生产配置为 1 vCPU、512 MB 内存和 500 MB 磁盘。

## 当前限制

- 单个房间最多两台设备。
- 会话状态只存在于单个 Node.js 进程中。
- 服务重启会清空所有活动房间。
- 当前版本没有账号、长期历史记录和多设备群组。

## 许可证

仓库当前未声明开源许可证。公开部署或分发前，请根据项目用途补充适当的许可证文件。
