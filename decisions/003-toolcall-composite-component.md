# ADR-003：ToolCall 复合组件（对齐 PolarClaw）

**日期**：2026-07-04  
**状态**：accepted（**基础设施阶段实现**）

## 背景

ReAct 类 workflow 需要工具调用。PolarClaw 已有成熟模型：常驻工具 + `skill_search` / `skill_activate` 动态扩表 + `runLoop` ReAct。

PolarUI ToolCall 应对齐为**图上的复合组件**，而非 executor 内黑盒 dispatch（已废弃，见旧 ADR-001）。

## 决策

### ToolCall 是什么

**复合节点**，GUI 可展开/配置：

1. **工具列表（tool list）** — 当前 LLM 可用的 function 定义（类似 PolarClaw `tools.list()`）
2. **元工具「加载需要的工具」** — 对齐 PolarClaw：
   - `skill_search` → 搜索 skills / 生态工具
   - `skill_activate` → 加载进 tool list
3. **LLM function calling** — ToolCall 内 LLM 从 tool list 选出 `tool_calls`
4. **执行** — 通过 **Switch 连到明面工具节点**（FileRead、WebSearch、SubAgent…），逻辑在**边**上

### ReAct 合规范式

```
LLM → Switch(branch: tool | finish)
  ├─ tool   → ToolCall（复合：tool list + 可选加载工具）
  │            → Switch(tool_name) ──边──→ FileRead | WebSearch | SubAgent | …（明面节点）
  │            → 结果回 ToolCall / LLM
  │         ──回环──→ LLM
  └─ finish → Output
```

### Skill 执行与嵌套

| 场景 | 行为 |
|------|------|
| `skill_activate` 后 call 该 skill 的工具 | 同一 ReAct 环，tool list 变长（PolarClaw 同） |
| 需独立子 Agent | 图上 **SubAgent** 节点，边上可见 |
| 子 workflow | 子图 / AgenticChain，图上可见 |

### function.name 约定

- 等于 **class_type**（如 `FileRead`、`WebSearch`）
- 无 snake_case 别名
- **不含 ShellExec**（见 ADR-004）

## 后果

- 基础设施阶段：重做 ToolCall 节点定义、executor、GUI tool list 编辑器
- 移除 `lib/tool-dispatch.mjs` 及 bundle `W5t()` patch
- claude-code 类 legacy 图：去掉 ShellExec，Switch→明面工具节点，ToolCall 作复合调度

## 参考

- `PolarClaw/src/adapters/skills/skill-discovery.ts` — skill_search / skill_activate
- `PolarClaw/src/core/agent.ts` — runLoop ReAct
- `skills/polarui-workflow-authoring/references/toolcall-composite.md`
