# ADR-009：PolarChat JWT 鉴权链与情景侧栏联动

**日期**：2026-07-10  
**状态**：accepted（已合入 `_template`，2026-07-09 于 `market-truth-cs` 首发验证）

## 背景

PolarChat 侧栏「用户 → 情景 → 会话」分组依赖 `GET /api/bootstrap` 返回的 `scenarios` + `sessions[].lc_conversation_id`。
前端 `usePolarScenarioIndex` 在 `scenarioOrder.length > 0` 时才会调用 `groupConversationsByScenario`，否则回退 LibreChat 默认的日期分组（「昨天」「上周」）。

2026-07-09 排查发现：登录后 bootstrap / sync / memory 间歇 401，侧栏只显示日期分组、顶栏情景为空。

## 根因

| # | 问题 | 后果 |
|---|------|------|
| R1 | LC `silentRefresh` / axios 401 拦截器刷新 token 后**只更新 axios header + React state**，未写回 `localStorage.token` | `polarFetch` 仍带 15min 过期 JWT → polar-api 401 |
| R2 | polar-api 对「带无效 Bearer」请求**不降级** `x-user-id`（`request-user.mjs` 设计） | 过期 token 比无 token 更糟 |
| R3 | `polarFetch` 不检查 `res.ok`，401 JSON 被当作 bootstrap 数据 | `scenarios` 为 `undefined`，静默回退日期分组 |
| R4 | `chat-context.ts` 上报活跃会话指针未带 JWT | 带坏 token 环境下一并失败 |
| R5 | `request.ts` 记忆 axios 拦截器硬编码 `:3920` 且缺 Authorization | 多发行版并行时可能打到错误 polar-api 实例 |

## 决策

### 1. 前端 token 单一来源（`auth-token.ts`）

- `getPolarAuthToken()`：`localStorage` 优先，axios `defaults.headers` 兜底
- `persistPolarAuthToken()`：登录 / 刷新后统一写 localStorage + `setTokenHeader` + `tokenUpdated` 事件
- `polarAuthHeaders()`：`polarFetch`、`polarNotifyActiveConvo`、记忆拦截器共用

### 2. `polarFetch` 401 自愈

收到 401 → `refreshPolarAuthToken()`（并发共用一次 LC refresh）→ 重试一次 → 仍失败则 `clearPolarBrowserSession()` + 跳转 `/login`。

### 3. 刷新链路补写 localStorage

- `packages/data-provider/src/request.ts` → `dispatchTokenUpdatedEvent`
- `client/src/hooks/AuthContext.tsx` → `setUserContext` / `silentRefresh` onSuccess

### 4. 情景侧栏联动条件（文档化，便于验收）

```
polar_user_id 存在
  → polarFetch /api/bootstrap 200 且 scenarios.length > 0
  → convoScenario 映射 lc_conversation_id → scenario_id
  → 侧栏 header = 情景标题（非「昨天」）
```

### 5. 端口策略（不变）

- 模版默认 fallback `:3920` / `:3080`
- 各发行版经 **PolarPort** 申领端口；构建时注入 `VITE_POLAR_API=http://127.0.0.1:{api_port}`
- 记忆拦截器优先 `window.__POLAR_API__`，否则与 `POLAR_API` 同 hostname 逻辑

## 实现位置（SSoT：`_template`）

| 文件 | 改动 |
|------|------|
| `upstream/librechat/client/src/polar/auth-token.ts` | 新增 |
| `upstream/librechat/client/src/polar/api.ts` | polarFetch 401 重试 |
| `upstream/librechat/client/src/polar/chat-context.ts` | polarAuthHeaders |
| `upstream/librechat/client/src/hooks/AuthContext.tsx` | localStorage 同步 |
| `upstream/librechat/packages/data-provider/src/request.ts` | dispatchTokenUpdatedEvent + 记忆 JWT |

改完后在发行版目录执行 `npm run build:librechat`（或重跑 `export-release.mjs` 触发 CoW 复制 + 构建）。

## 验收

1. 登录任意用户 → Network：`/api/bootstrap` 200，`scenarios.length ≥ 1`
2. 侧栏分组标题 = 情景名（非日期）
3. 控制台无持续 `3920` bootstrap 401（仅首屏竞态可接受）
4. `POLAR_LIVE_QA=1 npm run test:integration` 全链通过

## 关联

- `docs/WEB_EXPORT.md` §3.3
- `_template/docs/WORKFLOW_INTEGRATION.md` §8
- 首发验证：`~/Desktop/Web_related/market-truth-cs/`（PolarPort :3925 / :3085）
