# 开发者指南

## 常用命令

```bash
# 启动 Fastify 开发服务
npm run dev

# 执行 TypeScript 类型检查
npm run lint

# 运行 Vitest 测试
npm test

# 运行桌面和移动视口 Playwright E2E
npm run test:e2e

# 执行 TypeScript 检查并构建前端与服务端
npm run build

# 运行编译后的生产服务
npm start
```

## 开发约定

- 浏览器与服务端共享的协议放在 `shared` 目录。
- 浏览器代码放在 `client` 目录。
- Fastify 服务代码放在 `server` 目录。
- 运行时数据按技术设计保存在单进程内存中。
- 新增协议校验逻辑时同步添加 `.test.ts` 单元测试。

## 当前验证结果

- TypeScript 类型检查通过。
- 浏览器密码学会话、严格密文协议、文字确认重试与去重、图片分块重组、摘要验证、DataChannel 背压、HTTP 密文图片回退、跨通道幂等、直连恢复状态交换与缺失图片分块重传、房间生命周期、ICE 配置、PeerTransport、WebRTC 信令网关和限流器包含 67 个通过的单元及集成测试。
- Playwright 覆盖桌面与移动首页、创建房间、手动验证码确认、二维码公钥认证、Fragment 清理、真实 DataChannel 直连、加密文字直传、加密图片直传与解码、WebSocket 密文回退、刷新恢复，以及同一会话内先后传输文字和图片的综合流程。HTTP 图片回退由客户端协议、HTTP 路由和 WebSocket 通知集成测试覆盖，18 个桌面与移动 E2E 用例全部通过。
- 生产构建通过，前端产物输出到 `dist/client`，服务端产物输出到 `dist/server` 和 `dist/shared`。
- 本地预览：Fastify 使用 `npm run dev` 启动在 `3001`，Vite 使用 `npm exec vite -- --host 0.0.0.0 --port 5173` 启动在 `5173`；Vite 代理 `/api`、`/health` 和 `/ws`。
