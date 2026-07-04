# PolarUI Architecture Decision Records

> 关键架构决策。格式遵循 `_Polarisor/decisions/`。  
> **总览**：[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)

## 实施顺序

1. **文档**（当前）— ADR、skills、polaris.json  
2. **基础设施** — ToolCall 复合组件、移除错误 dispatch、graph engine 接入  
3. **具体 workflow** — taoci-outreach 等

## 索引

| 编号 | 标题 | 状态 | 日期 |
|------|------|------|------|
| 001 | [所见即所得 — 明面组件即全部逻辑](./001-wysiwyg-principle.md) | accepted | 2026-07-04 |
| 002 | [Harness 即 workflow 图本身](./002-harness-is-the-graph.md) | accepted | 2026-07-04 |
| 003 | [ToolCall 复合组件（对齐 PolarClaw）](./003-toolcall-composite-component.md) | accepted（待实现） | 2026-07-04 |
| 004 | [PolarUI workflow 没有 ShellExec](./004-no-shellexec.md) | accepted | 2026-07-04 |
| — | [~~ToolCall 内部分发~~](./001-toolcall-internal-dispatch.md) | **deprecated** | 2026-07-04 |

## 关联

- 进度：`../polaris.json`
- 撰写：`../skills/polarui-workflow-authoring/SKILL.md`
