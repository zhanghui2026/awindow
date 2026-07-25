# AWindow

AWindow 是一个无需登录的双设备临时传输工具。用户可以通过二维码或 6 位配对码连接两个设备，并在浏览器中双向传输文字和图片。

## 功能

- 最多两台设备加入临时房间
- 二维码和 6 位配对码配对
- 双向文字传输与复制
- JPEG、PNG、WebP、GIF 图片传输
- 单张图片最大 10 MB
- WebSocket 在线状态、消息确认与断线恢复
- 房间数据仅保存在进程内存中
- 桌面和移动浏览器响应式界面
- 无效配对与连接消息限流

## 技术栈

- TypeScript
- Fastify
- WebSocket
- Vite
- Vitest
- Playwright

## 开发运行

启动后端：

```bash
npm run dev
```

启动前端开发服务器：

```bash
npm exec vite -- --host 0.0.0.0 --port 5173
```

浏览器访问 `http://localhost:5173`。Vite 会把 `/api`、`/health` 和 `/ws` 代理到 `http://127.0.0.1:3001`。

## 验证

```bash
npm run lint
npm test
npm run test:e2e
npm run build
```

## 资源需求

- 推荐生产配置：1 vCPU、512 MB 内存、500 MB 磁盘
- 推荐开发配置：1 GB 内存、500 MB 磁盘
- 运行 Playwright E2E：建议 1 GB 以上内存和 1 GB 以上磁盘

## 数据生命周期

房间、文字、图片与设备连接状态只保存在单进程内存中。待配对房间 5 分钟后过期，两台设备都断开后保留 60 秒重连窗口，房间关闭后立即清理会话数据。
