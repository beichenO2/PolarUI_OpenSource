# PolarUI 单一事实源（SSoT）

> 读 PolarUI 文档，从这里开始。

## 文档层级

| 层级 | 文件 | 回答什么问题 |
|------|------|-------------|
| **定位** | [`SERVICES.md`](./SERVICES.md) | PolarUI 提供哪两种服务（A Agent 搭建 / B Agentic Workflow）？什么不属于 PolarUI？ |
| **架构** | [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 系统怎么分层？测试和部署怎么隔离？ |
| **前端** | [`FRONTEND.md`](./FRONTEND.md) | 怎么启动、怎么加载 workflow、画布看什么 |
| **网站模版** | [`WEB_TEMPLATE.md`](./WEB_TEMPLATE.md) | LibreChat 套壳、发行版命名、多模态 |
| **HTTP `/run` 契约** | [`WORKFLOW_RUN_CONTRACT.md`](./WORKFLOW_RUN_CONTRACT.md) | 任意语言插拔 Web 的一级约束（ADR-012） |
| **记忆设计** | [`MEMORY.md`](./MEMORY.md) | 三层记忆 + **分层查看 UI** |
| **验收标准** | [`WEB_ACCEPTANCE.md`](./WEB_ACCEPTANCE.md) | TDD 自动化门禁 |
| **开源参考** | [`WEB_REFERENCES.md`](./WEB_REFERENCES.md) | 可借鉴的开源 Chat UI |
| **路线图** | [`ROADMAP.md`](./ROADMAP.md) | 现在做什么、以后做什么、什么先搁置 |
| **决策** | [`../decisions/`](../decisions/) | 为什么这样设计（ADR） |
| **进度** | [`../polaris.json`](../polaris.json) | 每个 feature 做到哪了 |
| **操作** | [`../skills/`](../skills/) | Agent / 开发者操作指南（见下表） |

### Skills 索引

| 领域 | Skill | 回答什么问题 |
|------|-------|-------------|
| 工作流 · 画布 | [`polarui-workflow-authoring`](../skills/polarui-workflow-authoring/SKILL.md) | 怎么写 workflow `.json` 图 |
| 工作流 · Web 契约 | [`polarui-workflow-contract`](../skills/polarui-workflow-contract/SKILL.md) | Web 需要什么 workflow（builtin / **HTTP `/run`** / memory_delta） |
| Web · 部署 | [`polarui-web-deploy`](../skills/polarui-web-deploy/SKILL.md) | 怎么 export + Docker 上线（含外部 HTTP 服务） |
| 通用 | [`polarui-usage`](../skills/polarui-usage/SKILL.md) · [`polarui-deploy`](../skills/polarui-deploy/SKILL.md) | 启动 GUI · 部署入口索引 |

## 核心原则（一句话）

**双服务定位（ADR-011）**：PolarUI 只做 a) ClaudeCode 类基础 Agent 搭建（LLM + 结构化输出原子）与 b) Dify 类自进化 Agentic Workflow 搭建（ClaudeCode 型 Agent 为原子 + Harness）。详见 [`SERVICES.md`](./SERVICES.md)。

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
| 010 | [单引擎统一与纯粹化](../decisions/010-single-engine-and-purity-refactor.md) | accepted |
| 011 | [双服务定位与彻底瘦身](../decisions/011-two-services-and-slimdown.md) | accepted |
| 012 | [Workflow HTTP 插拔（`/run` 契约）](../decisions/012-workflow-http-plugin.md) | accepted |
| 013 | [项目引用地图（Project Map）](../decisions/013-project-map-refactor.md) | accepted |
| 014 | [自进化重建：干细胞与培养皿](../decisions/014-evolution-rebuild.md) | accepted |

## 进度追踪

`polaris.json` 按 requirement 分组：

- **R1** — 图引擎、WYSIWYG、套辞 workflow（测试开发）
- **R2** — PolarClaw Chat 壳（过渡）
- **R4** — 网站模版 `~/Desktop/Web_related/`
- **R3** — Workflow 记忆节点
- **R5** — 飞书渠道（**cancelled**，ADR-010 移出 PolarUI）
- **R6** — 单引擎统一与纯粹化（ADR-010/011）
- **R7** — Workflow HTTP 插拔（Phase 1 + P2a–P2e 全部 ✅，ADR-012）
- **R8** — 双服务定位与彻底瘦身（ADR-011；定位 SSoT = [`SERVICES.md`](./SERVICES.md)）
- **R9** — 项目引用地图 Project Map（ADR-013）
- **R10** — 自进化重建 StemCell / PetriDish（ADR-014）

## 关联生态

| 项目 | 关系 |
|------|------|
| PolarClaw | SessionMemory 等生态服务（WorkingMemory 等节点仍调用）；Chat 壳 `/api/workflow/chat` 属部署层 |
| PolarPrivate | LLM / Vault（preflight 检查） |
| PolarCopilot Hub | GUI 编辑器、文件 API（浏览器 session hub） |
