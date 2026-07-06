# ADR-005：测试开发与部署阶段严格隔离

**日期**：2026-07-06  
**状态**：accepted

## 背景

PolarUI workflow 曾把飞书 IM、会话路由、测试夹具混在同一图里，导致：
- 测试必须 mock 飞书才能跑
- 部署方案和测试方案纠缠
- 「workflow 只管 IO」的边界不清晰

## 决策

### 1. 两阶段严格隔离

| 阶段 | 边界 | 契约 |
|------|------|------|
| **测试开发** | workflow 图 + graph engine | `{ inputs } → { outputs }` JSON |
| **部署** | PolarClaw / Chat 壳 / 未来网站 | 用户、渠道、会话路由、preflight |

两阶段**可以共用同一份 `.lg.json`**，但：
- 测试图用 PromptInput / mock，不接真实渠道
- 部署图可含 FeishuIM 等渠道节点（部署专用变体，或部署层外包渠道）

### 2. Workflow 只管数据 IO

- 输入：`conversation_id`、`message`、`user_id`（可选）、`files`（可选）
- 输出：`reply`、`step`、`session_snapshot`、`artifacts`
- 不决定消息从飞书还是网页来

### 3. 渠道在部署层

- CLI：PolarClaw 收飞书消息 → 调 `run-graph-cli.mjs` → 回发
- Web：PolarClaw Chat 壳 → `/api/workflow/chat` → 展示 reply

### 4. 记忆拼接搁置

部署层会话（用户/情景/线程）与 workflow 图内记忆（WorkingMemory、SessionLoad/Save）的对齐方案**暂不决定**，记入 `docs/ROADMAP.md` R3。

## 后果

### 正面
- 测试可纯 mock，不依赖外部服务
- 部署渠道可换（飞书 → 网页）而不改 workflow 逻辑
- 文档和代码边界清晰

### 负面
- 可能需要「测试版图」和「部署版图」两份变体（或条件节点）
- 记忆拼接推迟，MVP 只能用单层 `conversation_id`

## 关联

- ADR-002 Harness 即图
- ADR-006 最简部署 MVP
- `docs/ARCHITECTURE.md` § 两阶段
- `docs/ROADMAP.md` R3
