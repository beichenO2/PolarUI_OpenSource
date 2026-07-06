# ADR-006：最简部署路径（MVP）

**日期**：2026-07-06  
**状态**：accepted

## 背景

部署阶段需要尽快可用。用户表示「不太清楚什么简单，但在功能可实现的前提下找最简单方案先用着」。

已有基础设施：
- PolarClaw `taoci-route.ts` → `run-graph-cli.mjs`（CLI）
- PolarClaw `/api/workflow/chat` + Chat 壳（Web）
- PolarUI `deploy-preflight.mjs` + gui-overlay（画布 executor）
- `PUT /api/deployments` 注册 + preflight gate

## 决策

MVP 部署**不新建独立网站**，复用 PolarClaw 现有通路。

### CLI 部署（已有）

```
飞书用户 → PolarClaw @套辞 → run-graph-cli.mjs → graph engine → JSON reply → 飞书回发
```

- PolarUI 不管 IM
- `conversation_id` 由 PolarClaw 从飞书 thread 派生

### Web 部署（近期接通）

```
浏览器 → PolarClaw /chat?workflow=xxx → POST /api/workflow/chat → run-graph-cli.mjs → reply
```

- 不建 `~/Desktop/Web_related/` 独立站（推迟到 R4）
- 用户输入 `conversation_id`（或自动生成 UUID）

### 会话模型（MVP 最简）

| 维度 | MVP 做法 | 完整方案（R3 后） |
|------|---------|-----------------|
| 用户 | `user_id` 透传，不鉴权 | username 登录 / token |
| 情景 | 不拆分，换老师 = 新 `conversation_id` | `scenario_id` |
| 对话线程 | 不拆分，换问题 = 同一 `conversation_id` 继续 | `thread_id` |
| 存储 | `.sessions/{conversation_id}.json` | 待 R3 设计 |

### 上线流程

```
PolarUI 画布 → PUT /api/deployments
  → deploy-preflight（PolarPrivate / Vault / xelatex / executor）
  → 写入 chat-deployments.json
  → 返回 chat_url
```

## 后果

### 正面
- 零新服务，几天内可跑通
- CLI 和 Web 共用同一 graph engine 契约
- 功能可达，不阻塞测试开发迭代

### 负面
- 无独立品牌网站
- 无情景/线程 UI
- 用户隔离弱（内测 only）

### 后续行动

- R2：画布一键上线 + Chat 壳验证
- R3：记忆拼接方案
- R4：`~/Desktop/Web_related/` 模版站

## 关联

- ADR-005 测试/部署隔离
- `docs/ROADMAP.md` R2/R3/R4
- PolarClaw `server.ts` `/api/deployments`、`/api/workflow/chat`
