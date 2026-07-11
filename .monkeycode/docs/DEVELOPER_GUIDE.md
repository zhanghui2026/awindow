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

# 执行 TypeScript 检查并构建前端
npm run build
```

## 开发约定

- 浏览器与服务端共享的协议放在 `shared` 目录。
- 浏览器代码放在 `client` 目录。
- Fastify 服务代码放在 `server` 目录。
- 运行时数据按技术设计保存在单进程内存中。
- 新增协议校验逻辑时同步添加 `.test.ts` 单元测试。

## 当前验证结果

- TypeScript 类型检查通过。
- 共享协议、房间生命周期、HTTP 路由、WebSocket 网关和限流器包含 29 个通过的单元及集成测试。
- Playwright 包含 6 个通过的桌面与移动端 E2E，覆盖首页布局、创建房间和双设备配对工作区。
- Vite 生产构建通过，产物输出到 `dist/client`。
- 本地预览：Fastify 使用 `npm run dev` 启动在 `3001`，Vite 使用 `npm exec vite -- --host 0.0.0.0 --port 5173` 启动在 `5173`；Vite 代理 `/api`、`/health` 和 `/ws`。
- 当前预览地址：`https://5173-d9b1166670274e72.monkeycode-ai.online`。
