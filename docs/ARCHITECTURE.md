# PolarUI 架构

> **SSoT 入口**：[`docs/SSoT.md`](./SSoT.md)  
> **路线图**：[`docs/ROADMAP.md`](./ROADMAP.md)  
> **进度**：[`polaris.json`](../polaris.json)

---

## 总览

PolarUI = ComfyUI 风格 workflow 编辑器 + 图执行引擎。

**核心分工**：

| 层 | 职责 | 不负责 |
|----|------|--------|
| **Workflow（图）** | 数据变换：输入 JSON → 状态机/LLM/工具 → 输出 JSON | 用户从哪来、网页怎么渲染 |
| **部署层（网站）** | 用户身份、会话路由、Chat UI、上线 preflight | 业务状态机逻辑 |

---

## 两阶段（严格隔离）

### 阶段一：测试开发

**契约**：

```
{ conversation_id, message, user_id?, files? }
        ↓
   graph engine (headless)
        ↓
{ ok, reply, step, session_snapshot?, node_traces }
```

- 图上明面节点：WorkingMemory、UserMemoryLoad、ScenarioMemoryLoad/Save、Switch、LLM、SubAgent、**Output**
- Mock executor（`TAOCI_MOCK_LLM=1`）
- Benchmark 直连 `lib/run-graph-cli.mjs`
- **禁止**渠道节点（FeishuIM 等）出现在 workflow 图里

### 阶段二：部署（网站）

**唯一部署通路**（ADR-006）：

```
浏览器 Chat UI
  → POST /api/workflow/chat
  → run-graph-cli.mjs
  → graph engine
  → JSON reply 展示给用户
```

PolarUI 只提供 IO 服务：`conversation_id + message` 进，`reply + step` 出。

**部署层职责**：
- 用户隔离（username / user_id）
- 会话路由（conversation_id）
- 网页 Chat UI
- 上线 preflight（PolarPrivate、Vault、xelatex、executor）

**飞书等 IM 渠道**：不在当前范围，见 [`ROADMAP.md`](./ROADMAP.md) R5。

### 记忆管理（R3 ✅）

三层记忆节点：`UserMemoryLoad`（只读）、`ScenarioMemoryLoad/Save`、`SessionMemoryLoad/Save`。  
网站发行版为 SSoT，workflow 通过 `--memory-json` 增量读写；详见 [`MEMORY.md`](./MEMORY.md)。

### Web 发行版（R4 ✅）

`export-release.mjs` 编译 `_template/` → `~/Desktop/Web_related/{release_id}/`；双入口 CLI + PolarUI Web。详见 [`WEB_EXPORT.md`](./WEB_EXPORT.md)。

---

## 图内原则

1. **WYSIWYG** — [ADR-001](../decisions/001-wysiwyg-principle.md)
2. **Harness = 图** — [ADR-002](../decisions/002-harness-is-the-graph.md)
3. **没有 ShellExec** — [ADR-004](../decisions/004-no-shellexec.md)
4. **ToolCall 复合组件** — [ADR-003](../decisions/003-toolcall-composite-component.md)
5. **没有渠道节点** — 输出走 Output 节点，渠道在部署层

---

## 运行时结构

```
workflows/*.lg.json          ← 图源
        │
        ├─ lib/headless-engine.mjs   ← Node 执行
        ├─ lib/run-graph-cli.mjs     ← IO 契约
        └─ lib/gui-overlay.mjs       ← 浏览器 executor overlay
```

| 环境 | Memory 节点 | PDF compile |
|------|------------|-------------|
| Node | `lib/memory-graph/register.mjs` + `--memory-json` | xelatex |
| Browser | `lib/memory-graph/register-gui.mjs` + Hub API | 跳过 |

---

## 文档索引

| 路径 | 内容 |
|------|------|
| `docs/SSoT.md` | 文档入口 |
| `docs/ROADMAP.md` | 路线图 |
| `docs/ARCHITECTURE.md` | 本文 |
| `polaris.json` | 功能进度 |
| `decisions/` | ADR |
