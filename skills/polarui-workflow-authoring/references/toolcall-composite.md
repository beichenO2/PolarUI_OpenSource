# ToolCall 复合组件 — 与 PolarClaw 对照

> ADR-003。基础设施阶段实现；撰写 workflow 时按此规格规划。

## PolarClaw 模型（已实现）

来源：`PolarClaw/src/core/agent.ts`、`PolarClaw/src/adapters/skills/skill-discovery.ts`

```
启动
  metaIndex 扫描 skills/（只读 SKILL.md，不加载 tools.ts）
  常驻 ~17 工具 + skill_search / skill_activate / skill_deactivate

runLoop（ReAct）
  while round < maxRounds:
    LLM(messages, tools.list())
    if no tool_calls → return text
    for each tool_call:
      tools.execute(name, args)   // 含 skill_activate 动态注册
    append tool results → 下一轮 LLM
```

### 三个关键工具

| 工具 | 作用 |
|------|------|
| `skill_search` | 搜本地 + 生态 skills（query + source） |
| `skill_activate` | 加载 skill 的 tools.ts 进 executor，**扩充 tools.list()** |
| `skill_deactivate` | 卸载 skill，释放工具槽 |

这就是用户说的 **「加载需要的工具」**：先 search，再 activate，tool list 变长。

### Skill 执行是否嵌套？

| 情况 | PolarClaw 行为 |
|------|----------------|
| activate 后 call 该 skill 的工具 | **同一 runLoop**，不新开环 |
| 工具很重 | 单次 execute，仍同一环 |
| 需独立子 Agent | PolarUI 侧用 **SubAgent 节点**在图上表达 |

---

## PolarUI ToolCall 目标形态

### 复合节点（GUI 可见）

| 部分 | 说明 |
|------|------|
| **tool list** | 当前可用 function 定义列表（params / 子面板可编辑） |
| **加载需要的工具** | 内置元能力，对齐 skill_search + skill_activate |
| **LLM 调用** | 从 tool list 做 function calling → 输出 `tool_calls` |
| **execute_tools** | **不在 executor 内 dispatch**；交给下游 Switch + 明面节点 |

### 与图的连接

```
ToolCall.outputs.tool_calls
  → Switch（按 function.name 或 branch）
  → FileRead | WebSearch | KnowLeverSearch | SubAgent | …
  → 结果 Merge / 回 LLM
```

每条执行路径是**可见边**。

### function.name 约定

- 等于 node-def `class_type`（`FileRead`、`WebSearch`…）
- 无 snake_case 别名
- **无 ShellExec**

---

## 当前实现差距（文档记录，基础设施阶段修）

| 项 | 现状 | 目标 |
|----|------|------|
| ToolCall executor | `W5t()` 内部分发（deprecated） | 只产出 tool_calls + 更新 tool list |
| tool list GUI | 仅 tool_definitions 输入槽 | 可编辑列表 + 搜索加载 |
| skill_search/activate | 无 | 对齐 PolarClaw 或复用 adapter |
| Switch→明面节点 | claude-code 有但含 ShellExec legacy | 去 ShellExec，作标准范式 |

---

## 撰写 checklist

- [ ] ToolCall 节点在图上可见，tool list 可解释
- [ ] 「加载需要的工具」有对应元能力（或文档说明暂用静态 list）
- [ ] 每个可执行工具都有**明面节点** + Switch 边
- [ ] 无 ShellExec
- [ ] trace 含 FileRead/WebSearch 等 class_type，不是只有 ToolCall
