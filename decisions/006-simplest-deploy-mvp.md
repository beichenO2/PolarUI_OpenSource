# ADR-006：最简部署路径（网站 MVP）

**日期**：2026-07-06（修订 2026-07-07）  
**状态**：superseded（2026-07-12，由 ADR-008 / ADR-010 取代）

> **2026-07-12 修订**：PolarUI 对外唯一「一键上线」路径确立为 **R4 export-release
> （LibreChat 模版，ADR-008）**；ADR-010 已从 PolarUI 剥离 PolarClaw GUI 集成。
> 本 ADR 描述的「画布 → PUT /api/deployments → chat_url」不再实现 GUI 入口。
> PolarClaw 侧 `/api/workflow/chat` 与 `/api/deployments` 保留为**开发调试工具**
> （curl 手动调用），不属于 PolarUI 对外部署契约。R2 相应关闭（cancelled）。

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
