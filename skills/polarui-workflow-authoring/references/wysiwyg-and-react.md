# WYSIWYG 与 ReAct 图结构

> 对齐 `docs/ARCHITECTURE.md`、ADR-001/003/004

## 核心：所见即所得

**图上看见的节点 + 连线 = 全部逻辑。**

- ✅ Switch 的边连到 FileRead、WebSearch、SubAgent — 执行路径在图上
- ❌ ToolCall executor 内部 dispatch — 图上看不见
- ❌ `harness/index.mjs` — 图外 CLI
- ❌ ShellExec — **不存在**

---

## 合规范式 A — 状态机 workflow（套辞等）

```
PromptInput / FeishuIM（入站）
  → WorkingMemory
  → Switch(session.step)
  → S0: LLM | S1: SubAgent×n | S2: LLM | S3: LLM
  → FeishuIM（出站 + PDF）
  → Output
```

每步、每条边在 GUI 可见。

---

## 合规范式 B — ReAct + ToolCall 复合组件

```
LLM
  → Switch(branch: tool | finish)
      ├─ tool → ToolCall（复合节点）
      │           ├─ tool list（GUI 可见）
      │           ├─ 元工具：加载需要的工具（≈ skill_search + skill_activate）
      │           └─ LLM 产出 tool_calls
      │         → Switch(tool_name)
      │           ├─→ FileRead（明面节点）
      │           ├─→ WebSearch（明面节点）
      │           ├─→ SubAgent（明面节点）
      │           └─→ …
      │         → 结果回 LLM（回环）
      └─ finish → Output
```

**要点：**

- ToolCall 是**复合调度节点**，不是 executor 黑盒
- 工具**执行**发生在 Switch 连出去的**明面节点**
- 详见 `toolcall-composite.md`

---

## 反例

### A — 外挂 harness CLI（taoci 现状）

```
PromptInput → ShellExec(node harness/index.mjs) → Output
```

Harness 应在 `.lg.json` 里，不是 CLI 文件夹。

### B — ToolCall 内部分发（已废弃）

```
ToolCall executor 内部 W5t() → 偷偷调 FileRead/WebSearch
```

违反 WYSIWYG。见 `decisions/001-toolcall-internal-dispatch.md`（deprecated）。

### C — ShellExec 任何形式

不存在。见 ADR-004。

---

## 参考图

| 文件 | 说明 |
|------|------|
| `dist/workflows/test-multi-turn-chat.json` | WorkingMemory → LLM（多轮参考） |
| `dist/workflows/claude-code.lg.json` | ⚠️ legacy：含 ShellExec，待迁移 |
| `workflows/taoci-outreach/taoci-outreach.lg.json` | ⚠️ 反例：ShellExec 黑盒 |

---

## 套辞

无 ReAct 终端工具。纯状态机范式 A，见 `WORKFLOW.spec.md`。
