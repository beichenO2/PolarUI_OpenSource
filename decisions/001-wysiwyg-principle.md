# ADR-001：所见即所得 — 明面组件即全部逻辑

**日期**：2026-07-04  
**状态**：accepted

## 背景

PolarUI 是 ComfyUI 风格 workflow 编辑器。用户要求：**图上看见的就是全部逻辑**，不能藏在外部 CLI、executor 黑盒或未连线节点里。

曾错误实现 ToolCall executor 内部分发（见已废弃 `001-toolcall-internal-dispatch.md`），违反本原则。

## 决策

1. **WYSIWYG**：`.lg.json` 中每个业务步骤对应可见节点 + 可见连线；trace 可逐步解释。
2. **逻辑在边上**：Switch / 条件边决定下一节点；工具执行发生在**图上的工具节点**，不是 ToolCall 内部偷偷调用 executor。
3. **禁止占位节点**：WorkingMemory、PromptInput 等必须有有效下游；不得装饰性悬挂。
4. **禁止图外 harness CLI**：`workflows/*/harness/` 不得作为生产逻辑载体（Harness = 图，见 ADR-002）。

## 后果

- 撰写 workflow 时先画状态机与节点清单，再写 `.lg.json`。
- 新增能力优先补 **palette 可见节点**，而非 executor 内魔法。
- GUI 审图即可评审架构，无需读 minified bundle。

## 关联

- ADR-002 Harness 即图
- ADR-003 ToolCall 复合组件
- ADR-004 没有 ShellExec
