# PolarUI 节点清单（撰写 workflow 时对照）

> 来源：`PolarUI/dist/node-defs/index.json`  
> 原则：见 `docs/ARCHITECTURE.md`、ADR-001

## 多轮 / 状态机常用（palette 可见）

| class_type | 文件 | 用途 |
|------------|------|------|
| PromptInput | core.json | 入站消息 / 触发 |
| WorkingMemory | polar-memory.json | 多轮 session / conversation_id |
| LLM | core.json | 单步 LLM 调用 |
| Switch | core.json | 条件路由（step / branch / tool_name） |
| Validator | core.json | 单步输出校验 |
| RetryLoop | core.json | 单步失败重试（**非**用户多轮对话） |
| Output | core.json | 终点 |
| SubAgent | tools-system.json | 委派子任务 / 子 Agent 环 |
| Notification | tools-system.json | 桌面/Hub 通知 |

## ReAct / 工具（palette 可见，Switch 连边执行）

| class_type | 文件 | 用途 |
|------------|------|------|
| **ToolCall** | core.json | **复合节点**：tool list + LLM function calling（见 ADR-003） |
| FileRead | tools-system.json | 读文件 — **明面节点**，Switch 连边 |
| FileWrite | tools-system.json | 写文件 |
| WebSearch | tools-system.json | 检索 |
| KnowLeverSearch | knowlever.json | 知识库 |
| GrepSearch / GlobSearch | tools-system.json | 代码搜索 |
| MCPCall | tools-system.json | MCP |
| CodeExec | tools-system.json | 沙箱代码 |

⛔ **没有 ShellExec**（ADR-004）

## 合规图结构

**状态机：**

```
WorkingMemory → Switch(step) → LLM / SubAgent → Output
```

**ReAct：**

```
LLM → Switch → ToolCall（复合）→ Switch(tool) → FileRead | WebSearch | … → 回 LLM
```

详见 `wysiwyg-and-react.md`、`toolcall-composite.md`。

## 禁止作为 workflow 主干

| 反模式 | 说明 |
|--------|------|
| 外挂 `harness/index.mjs` | Harness = 图（ADR-002） |
| ToolCall executor 内 dispatch | 已废弃 |
| ShellExec 任意形式 | 不存在（ADR-004） |
| 悬空 WorkingMemory | 必须有下游连线 |

## 撰写查缺模板

```
状态/步骤 → class_type → 库中有？ → 无则步骤3补节点
────────────────────────────────────────────────────
S0 澄清     → LLM + Validator + Switch
S1 调研     → SubAgent ×3 + Merge
状态路由    → Switch(session.step)
记忆        → WorkingMemory → LLM context
文件/检索   → Switch → FileRead / WebSearch（明面节点）
ReAct 调度  → ToolCall（复合）+ Switch → 工具节点
出站回复    → Output（渠道接入属部署层，ADR-010）
```

## Legacy（待基础设施阶段清理）

`dist/node-defs/tools-system.json` 中 **ShellExec** 仍存在于 node-defs，**不得**用于新 workflow。
