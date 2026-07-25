# AWindow 项目指引

## 项目定位

AWindow 是一个无需登录的双设备临时文字和图片传输工具。二维码或 6 位配对码用于配对，房间、消息和图片仅保存在单个服务进程内存中。

## 常用命令

```bash
npm run dev
npm exec vite -- --host 0.0.0.0 --port 5173
npm run lint
npm test
npm run test:e2e
npm run build
npm start
```

开发模式下 Fastify 监听 `127.0.0.1:3001`，Vite 监听 `5173` 并代理 `/api`、`/health` 和 `/ws`。生产模式先执行 `npm run build`，再通过 `npm start` 运行编译后的服务端；静态资源由反向代理托管 `dist/client`。

## 技术与目录

- `client/`：Vite 浏览器客户端。
- `server/`：Fastify HTTP、WebSocket、房间和限流逻辑。
- `shared/`：前后端共享协议与校验。
- `tests/e2e/`：Playwright 桌面和移动端流程。
- `.monkeycode/docs/`：现役项目文档。
- `.monkeycode/specs/`：需求、设计和实施记录。

## 开发约定

- 保持每个房间最多两台设备和单进程内存存储边界。
- 协议变更同步更新 `shared/protocol.ts`、测试和接口文档。
- 浏览器显示用户输入时使用纯文本 DOM API。
- 保持 WebSocket/HTTP 传输可用；WebRTC 规划采用直连优先和自动回退。
- 不修改与 AWindow 无关的 NodeLoc 文件。

## 当前状态

基础房间、配对、文字和图片传输、断线恢复、限流、生产编译与双端 E2E 已完成。WebRTC DataChannel 仍处于需求和技术设计阶段，规格位于 `.monkeycode/specs/2026-07-19-webrtc-data-transfer/`。
