# PolarUI Architecture Decision Records

> **SSoT 入口**：[`docs/SSoT.md`](../docs/SSoT.md)  
> **架构总览**：[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)  
> **路线图**：[`docs/ROADMAP.md`](../docs/ROADMAP.md)

## 索引

| 编号 | 标题 | 状态 | 日期 |
|------|------|------|------|
| 001 | [所见即所得 — 明面组件即全部逻辑](./001-wysiwyg-principle.md) | accepted | 2026-07-04 |
| 002 | [Harness 即 workflow 图本身](./002-harness-is-the-graph.md) | accepted | 2026-07-04 |
| 003 | [ToolCall 复合组件（对齐 PolarClaw）](./003-toolcall-composite-component.md) | accepted | 2026-07-04 |
| 004 | [PolarUI workflow 没有 ShellExec](./004-no-shellexec.md) | accepted | 2026-07-04 |
| 005 | [测试开发与部署阶段严格隔离](./005-test-deploy-separation.md) | accepted | 2026-07-06 |
| 006 | [最简部署路径（MVP）](./006-simplest-deploy-mvp.md) | accepted | 2026-07-06 |
| 007 | [记忆三层与网站 SSoT](./007-memory-three-layers.md) | accepted | 2026-07-07 |
| 008 | [Web 发行版 + LibreChat 套壳](./008-web-release-librechat.md) | accepted | 2026-07-07 |
| 010 | [单引擎统一与纯粹化重构（QA 门禁先行）](./010-single-engine-and-purity-refactor.md) | accepted | 2026-07-10 |
| 011 | [双服务定位与彻底瘦身](./011-two-services-and-slimdown.md) | accepted | 2026-07-10 |
| 012 | [Workflow HTTP 插拔（`/run` 契约）](./012-workflow-http-plugin.md) | accepted | 2026-07-10 |
| — | [~~ToolCall 内部分发~~](./001-toolcall-internal-dispatch.md) | **deprecated** | 2026-07-04 |

## 阅读顺序

1. ADR-005（两阶段）→ ADR-006（网站 MVP）→ ADR-007（记忆三层）→ ADR-008（Web）→ **ADR-012（HTTP `/run`）**
2. ADR-001–004（图内原则）
3. ADR-010/011（引擎统一与双服务）

## 关联

- 进度：`../polaris.json`
- 撰写：`../skills/polarui-workflow-authoring/SKILL.md`
