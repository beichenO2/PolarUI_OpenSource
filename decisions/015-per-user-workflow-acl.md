# ADR-015：按用户开 Workflow 权限（壳侧 ACL）

- 状态：**accepted**（2026-07-11 用户确认，含两条简化批注）
- 日期：2026-07-11
- 关联：ADR-012（`/run` 契约不动）、R7 Phase 1（http_workflows 三路分发）

## 背景

单站（market-truth-cs）多用户共用，模型下拉当前对所有人可见全部 workflow。
需求：Admin 后台能按用户勾选可用 workflow（含 `polarflow-*` / `mta-python` / builtin / graph-cli 全部 id）。

调研事实：

1. 用户存储是 `data/store.json`（PolarDb）；用户 schema 现为 `{ id, is_admin, created_at, ... }`。
2. LibreChat `modelSpecs` 是静态 yaml，无 per-user 能力；LC models 缓存全局。
3. 请求身份：polar API 用 LC JWT（`request-user.mjs`）；LC → `/v1/chat/completions` 走 `x-lc-user-email`。

## 用户定调（设计约束）

- **Admin 本质是可视化后台，不是用户**——权限模型里没有"admin 用户豁免"这类特殊分支；
  Admin 控制台走自己的 `admin-auth`，与聊天用户体系正交。
- **其他用户一视同仁管理，不做奇怪的设计**。
- **不执着于单实例内 UI 菜单 per-user 过滤**：菜单全局统一即可；
  若真需要硬隔离的可见性，运维层面部署多个 LibreChat 实例（各配各的 modelSpecs），不搞客户端 hack。

## 决策

权限完全在壳侧（polar 层），`/run` 契约零改动。三件事：

### D1 数据模型（PolarDb / store.json）

```
users[id].allowed_workflows: string[] | null
```

- `null`（缺省）= 不限制 —— 存量用户行为不变
- `["polarflow-support-triage", ...]` = 白名单（站点默认 `workflow_id` 始终隐含允许，保证用户总有可用模型）
- 所有用户同一套规则，无特殊角色分支

### D2 Admin 后台

- `GET /api/admin/workflows`：`listWorkflows(config)` 全量目录（id/label/kind）
- `PATCH /api/admin/users/:id`：body `{ allowed_workflows: string[] | null }`
- 用户详情页加勾选面板：「不限制」开关 + workflow checkbox 列表

### D3 服务端强制（唯一安全边界）

- `POST /v1/chat/completions`（openai-compat → process-chat）：
  执行前校验 `body.model` ∈ 用户生效集合，未授权 → 正常 assistant 回复友好拒绝文案
  （避免 LC 弹错误框），不进 workflow。
- `GET /v1/models`：能解析出用户身份时同样过滤（尽力而为）。

## 不做

- 不改 `/run` 契约 / PolarFlow 服务端（权限与引擎正交）
- 不做客户端菜单 hack（polar-boot 过滤 modelSpecs）——菜单全局统一，硬隔离靠多实例部署
- 不引入角色/组概念

## 实施顺序（template-first）

1. `_template`：PolarDb 字段 + admin API/UI + D3 校验 + 单测
2. `npm run test:web-release` 全绿
3. re-export 同步 market-truth-cs，验收：未授权 model 直接 POST 被友好拒绝；
   Admin 勾选实时生效
