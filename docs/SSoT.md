# PolarUI 单一事实源（SSoT）

> 读 PolarUI 文档，从这里开始。

## 文档层级

| 层级 | 文件 | 回答什么问题 |
|------|------|-------------|
| **架构** | [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 系统怎么分层？测试和部署怎么隔离？ |
| **前端** | [`FRONTEND.md`](./FRONTEND.md) | 怎么启动、怎么加载 workflow、画布看什么 |
| **网站模版** | [`WEB_TEMPLATE.md`](./WEB_TEMPLATE.md) | LibreChat 套壳、发行版命名、多模态 |
| **记忆设计** | [`MEMORY.md`](./MEMORY.md) | 三层记忆 + **分层查看 UI** |
| **验收标准** | [`WEB_ACCEPTANCE.md`](./WEB_ACCEPTANCE.md) | TDD 自动化门禁 |
| **开源参考** | [`WEB_REFERENCES.md`](./WEB_REFERENCES.md) | 可借鉴的开源 Chat UI |
| **路线图** | [`ROADMAP.md`](./ROADMAP.md) | 现在做什么、以后做什么、什么先搁置 |
| **决策** | [`../decisions/`](../decisions/) | 为什么这样设计（ADR） |
| **进度** | [`../polaris.json`](../polaris.json) | 每个 feature 做到哪了 |
| **操作** | [`../skills/`](../skills/) | Agent / 开发者怎么写 workflow、怎么部署 |

## 核心原则（一句话）

**Web = Workflow 发行版**（快速部署，无自动同步；更新 = 新文件夹 `原名_1`）

## 两阶段（严格隔离）

```
┌─────────────────────────────────────────────────────────┐
│  测试开发阶段                                            │
│  输入 JSON → graph engine → 输出 JSON                    │
│  不考虑用户从哪来、怎么交互                                │
└─────────────────────────────────────────────────────────┘
                          │  部署时接入
                          ▼
┌─────────────────────────────────────────────────────────┐
│  部署阶段（独立网站）                                     │
│  ~/Desktop/Web_related/{site}/                          │
│  用户-主题-会话 · 记忆归网站 · 调 workflow               │
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
| 006 | [最简部署路径（网站 MVP）](../decisions/006-simplest-deploy-mvp.md) | accepted |
| 007 | [记忆三层与网站 SSoT](../decisions/007-memory-three-layers.md) | accepted |
| 008 | [Web 发行版 + LibreChat 套壳](../decisions/008-web-release-librechat.md) | accepted |

## 进度追踪

`polaris.json` 按 requirement 分组：

- **R1** — 图引擎、WYSIWYG、套辞 workflow（测试开发）
- **R2** — PolarClaw Chat 壳（过渡）
- **R4** — 网站模版 `~/Desktop/Web_related/`（**当前重点**）
- **R3** — Workflow 记忆节点
- **R5** — 飞书渠道（搁置）

## 关联生态

| 项目 | 关系 |
|------|------|
| PolarClaw | 过渡：Chat 壳 `/api/workflow/chat`；最终由各站 `server` 直连 workflow |
| PolarPrivate | LLM / Vault（preflight 检查） |
| PolarCopilot Hub | GUI 编辑器、文件 API（浏览器 session hub） |
