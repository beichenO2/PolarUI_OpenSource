# ADR-005：测试开发与部署阶段严格隔离

**日期**：2026-07-06（修订 2026-07-07）  
**状态**：accepted

## 背景

PolarUI workflow 曾把渠道、会话路由、测试夹具混在同一图里。现收敛为**网站优先**，飞书移入 roadmap。

## 决策

### 1. 两阶段严格隔离

| 阶段 | 边界 | 契约 |
|------|------|------|
| **测试开发** | workflow 图 + graph engine | `{ inputs } → { outputs }` JSON |
| **部署** | 网站 Chat 壳 | 用户、会话路由、preflight |

### 2. Workflow 只管数据 IO

- 输入：`conversation_id`、`message`、`user_id?`、`files?`
- 输出：`reply`、`step`、`session_snapshot`、`artifacts`
- 图上**不含渠道节点**（无 FeishuIM）；输出走 Output 节点

### 3. 部署 = 网站

```
浏览器 → PolarClaw /api/workflow/chat → run-graph-cli.mjs → reply
```

飞书、CLI 等渠道不在当前范围，见 `docs/ROADMAP.md` R5。

### 4. 记忆拼接搁置（R3）

MVP 只用单层 `conversation_id`。

## 关联

- ADR-006 网站 MVP
- `docs/ROADMAP.md` R3、R5
