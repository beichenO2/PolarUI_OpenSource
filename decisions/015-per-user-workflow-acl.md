# ADR-015：按用户开 Workflow 权限（壳侧 ACL）

- 状态：**proposed**（待用户确认后实施）
- 日期：2026-07-11
- 关联：ADR-012（`/run` 契约不动）、R7 Phase 1（http_workflows 三路分发）

## 背景

单站（market-truth-cs）多用户共用，模型下拉当前对所有人可见全部 workflow。
需求：Admin 能按用户勾选可用 workflow（含 `polarflow-*` / `mta-python` / builtin / graph-cli 全部 id）。

调研结论（约束条件）：

1. 用户存储是 `data/store.json`（PolarDb），非 SQLite；用户 schema 现为
   `{ id, is_admin, created_at, ... }`，无权限字段。
2. LibreChat `modelSpecs` 是**静态 yaml**，schema 无 per-user/role 能力；
   且 LC 的 models fetch 结果进全局缓存——**服务端单靠 `/v1/models` 过滤无法真正 per-user 控制 UI 菜单**。
3. 请求身份三个来源：polar API 用 LC JWT（`request-user.mjs`）；
   LC → `/v1/chat/completions` 走 yaml 注入的 `x-lc-user-email`。

## 决策

权限完全在壳侧（polar 层），`/run` 契约零改动。四层配合：

### D1 数据模型（PolarDb / store.json）

```
users[id].allowed_workflows: string[] | null
```

- `null`（缺省）= 不限制，全部可见 —— 向后兼容，存量用户行为不变
- `[]` = 仅站点默认 workflow（`site.config.workflow_id`）
- `["polarflow-support-triage", ...]` = 白名单（默认 workflow 始终隐含允许）
- admin 用户永远不受限

### D2 Admin API + UI

- `GET /api/admin/workflows`：`listWorkflows(config)` 全量目录（id/label/kind）
- `PATCH /api/admin/users/:id`：body `{ allowed_workflows: string[] | null }`
- Admin 用户详情页（`admin.js` selectUser 区域）加 workflow 勾选面板：
  「不限制」开关 + checkbox 列表

### D3 服务端强制（真正的安全边界）

- `POST /v1/chat/completions`（openai-compat → process-chat）：
  执行前校验 `body.model` ∈ 用户 allowed 集合，未授权 → 200 + 友好拒绝文案
  （走正常 assistant 回复，避免 LC 弹错误框），不进 workflow。
- `GET /v1/models`：能解析出用户身份时同样过滤（尽力而为，不作为唯一防线）。

### D4 UI 菜单过滤（体验层）

- `/api/bootstrap`（或等价用户初始化接口）返回 `allowed_workflows` 生效集合
- `polar-boot.js` 客户端按该集合隐藏 `modelSpecs` 下拉中未授权项
- **不改 LibreChat 上游、不 fork ModelController**

## 不做

- 不改 `WORKFLOW_RUN_CONTRACT.md` / PolarFlow 服务端（权限与引擎正交）
- 不指望 `librechat.yaml` modelSpecs 做 per-user（schema 不支持）
- 不引入角色/组概念（当前规模按用户白名单足够，需要时再演化）

## 实施顺序（template-first）

1. `_template`：PolarDb 字段 + admin API/UI + D3 双端校验 + D4 bootstrap/boot 过滤 + 单测
2. `npm run test:web-release` 全绿
3. re-export 同步 market-truth-cs，验收：普通用户只见勾选项，admin 全见；
   直接 POST 未授权 model 被拒
