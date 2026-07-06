# PolarUI 单一事实源（SSoT）

> 读 PolarUI 文档，从这里开始。

## 文档层级

| 层级 | 文件 | 回答什么问题 |
|------|------|-------------|
| **架构** | [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 系统怎么分层？测试和部署怎么隔离？ |
| **路线图** | [`ROADMAP.md`](./ROADMAP.md) | 现在做什么、以后做什么、什么先搁置 |
| **决策** | [`../decisions/`](../decisions/) | 为什么这样设计（ADR） |
| **进度** | [`../polaris.json`](../polaris.json) | 每个 feature 做到哪了 |
| **操作** | [`../skills/`](../skills/) | Agent / 开发者怎么写 workflow、怎么部署 |

## 核心原则（一句话）

**Workflow 只管数据 IO；渠道、用户、会话路由在部署层。**

## 两阶段（严格隔离）

```
┌─────────────────────────────────────────────────────────┐
│  测试开发阶段                                            │
│  输入 JSON → graph engine → 输出 JSON                    │
│  不考虑消息从哪来、用户是谁、怎么交互                      │
└─────────────────────────────────────────────────────────┘
                          │  部署时接入
                          ▼
┌─────────────────────────────────────────────────────────┐
│  部署阶段                                                │
│  CLI（PolarClaw）/ 网站（Chat 壳）                        │
│  用户隔离 · 会话路由 · 渠道适配 · preflight               │
└─────────────────────────────────────────────────────────┘
```

详见 [`ARCHITECTURE.md` § 两阶段](./ARCHITECTURE.md#两阶段严格隔离)。

## ADR 索引

| 编号 | 标题 | 状态 |
|------|------|------|
| 001 | [所见即所得](../decisions/001-wysiwyg-principle.md) | accepted |
| 002 | [Harness 即图](../decisions/002-harness-is-the-graph.md) | accepted |
| 003 | [ToolCall 复合组件](../decisions/003-toolcall-composite-component.md) | accepted |
| 004 | [没有 ShellExec](../decisions/004-no-shellexec.md) | accepted |
| 005 | [测试/部署阶段隔离](../decisions/005-test-deploy-separation.md) | accepted |
| 006 | [最简部署路径（MVP）](../decisions/006-simplest-deploy-mvp.md) | accepted |

## 进度追踪

`polaris.json` 按 requirement 分组：

- **R1** — 图引擎、WYSIWYG、ToolCall、套辞 workflow（测试开发阶段）
- **R2** — 部署：preflight、CLI/Web 接入、画布一键上线
- **R3** — 搁置：部署层 ↔ workflow 记忆拼接（roadmap）

## 关联生态

| 项目 | 关系 |
|------|------|
| PolarClaw | 部署层：CLI 调 graph、IM 渠道、Chat 壳 `/api/workflow/chat` |
| PolarPrivate | LLM / Vault（preflight 检查） |
| PolarCopilot Hub | GUI 编辑器、文件 API（浏览器 session hub） |
