# ADR-006：最简部署路径（网站 MVP）

**日期**：2026-07-06（修订 2026-07-07）  
**状态**：accepted

## 背景

部署需要尽快可用。从**网站出发**，不建独立站、不接飞书。

## 决策

### 唯一部署通路

```
浏览器 Chat UI
  → POST /api/workflow/chat
  → run-graph-cli.mjs
  → graph engine
  → reply 展示
```

### 上线流程

```
PolarUI 画布 → PUT /api/deployments
  → preflight（PolarPrivate / Vault / xelatex / executor）
  → chat_url
```

### 会话模型（MVP）

| 维度 | 做法 |
|------|------|
| 用户 | `user_id` 透传，不鉴权 |
| 情景 | 换老师 = 新 `conversation_id` |
| 存储 | `.sessions/{conversation_id}.json` |

### 明确不做（当前）

- 飞书 IM 渠道 → R5
- PolarClaw CLI + 飞书回发 → R5
- `~/Desktop/Web_related/` 独立站 → R4

## 关联

- ADR-005 两阶段隔离
- `docs/ROADMAP.md` R2
