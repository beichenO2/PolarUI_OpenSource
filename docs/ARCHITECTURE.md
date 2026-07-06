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
| **Workflow（图）** | 数据变换：输入 JSON → 状态机/LLM/工具 → 输出 JSON | 用户从哪来、消息走哪个渠道 |
| **部署层（PolarClaw 等）** | 用户身份、会话路由、渠道 I/O、上线 preflight | 业务状态机逻辑 |

---

## 两阶段（严格隔离）

测试开发和部署是**两个独立阶段**，代码路径可以复用，但**设计约束不能混**。

### 阶段一：测试开发

**目标**：验证 workflow 逻辑正确。

**契约**：

```
{ conversation_id, message, user_id?, files? }
        ↓
   graph engine (headless)
        ↓
{ ok, reply, step, session_snapshot?, node_traces }
```

**允许**：
- 图上明面节点：WorkingMemory、TaociSessionLoad/Save、Switch、LLM、SubAgent
- Mock executor（`TAOCI_MOCK_LLM=1`）
- Benchmark 直连 `lib/run-graph-cli.mjs`
- 测试用 `.sessions/{id}.json` 作为 workflow 内部记忆载体

**禁止**：
- FeishuIM 作为测试入口（飞书是部署渠道，不是测试夹具）
- 在 executor 里藏渠道逻辑
- 为测试方便在图外写 harness CLI

### 阶段二：部署

**目标**：让真实用户用上 workflow。

**两种部署方案**（见 ADR-006）：

| 方案 | 谁调 workflow | 渠道在哪 |
|------|--------------|---------|
| **CLI** | PolarClaw `run-graph-cli.mjs` | PolarClaw 侧（飞书 IM 等） |
| **网站** | PolarClaw `/api/workflow/chat` | PolarClaw Chat 壳 |

PolarUI 部署时只提供**干净的 IO 服务**——接收 `conversation_id + message`，返回 `reply + step`。

**部署层额外职责**（workflow 不管）：
- 用户隔离（username / user_id）
- 会话路由（conversation_id 分配与查找）
- 渠道适配（飞书收发、网页 Chat UI）
- 上线 preflight（PolarPrivate、Vault、xelatex、executor 注册）

### 记忆管理：已知难题 → 搁置

Workflow 图内有记忆（WorkingMemory + SessionLoad/Save 节点）。  
部署层也有记忆需求（用户 / 情景 / 对话线程）。

**如何把部署层会话映射到 workflow 记忆，目前没有好方案。**  
→ 记入 [`ROADMAP.md`](./ROADMAP.md) R3，MVP 阶段不解决。

**MVP 妥协**：部署层只传 `conversation_id`，workflow 自己读写 `.sessions/{conversation_id}.json`。一层 key，不做情景/线程拆分。

---

## 图内原则（测试开发阶段也适用）

### 1. 所见即所得（WYSIWYG）

图上能看见的明面组件 = 全部业务逻辑。详见 [ADR-001](../decisions/001-wysiwyg-principle.md)。

### 2. Harness = 图

`taoci-outreach.lg.json` 就是 harness，不是 `harness/` 文件夹。详见 [ADR-002](../decisions/002-harness-is-the-graph.md)。

### 3. 没有 ShellExec

PolarUI workflow 不存在 ShellExec 组件。详见 [ADR-004](../decisions/004-no-shellexec.md)。

### 4. ToolCall = 复合组件

对齐 PolarClaw 工具模型；Switch 连明面工具节点。详见 [ADR-003](../decisions/003-toolcall-composite-component.md)。

---

## 运行时结构

```
workflows/*.lg.json          ← 图源（SSoT）
        │
        ├─ npm run build
        │     ├─ dist/               ← GUI bundle
        │     ├─ dist/workflows/     ← sync-workflows 同步
        │     └─ dist/overlay/       ← gui-overlay（浏览器 executor）
        │
        ├─ lib/headless-engine.mjs   ← Node headless 入口
        ├─ lib/run-graph-cli.mjs     ← CLI IO 契约
        └─ lib/gui-overlay.mjs       ← 浏览器/Node executor 分流
```

**Executor 分流**：

| 环境 | TaociSessionLoad/Save | FeishuIM | PDF compile |
|------|----------------------|----------|-------------|
| Node (headless) | `register.mjs` + 本地 fs | 完整实现 | xelatex |
| Browser (GUI) | `register-gui.mjs` + Hub API | stub | 跳过 |

---

## 已废弃（勿引用）

| 方案 | 说明 |
|------|------|
| ToolCall executor 内部分发 | 违反 WYSIWYG |
| `workflows/*/harness/` CLI | Harness = 图 |
| 测试阶段接 FeishuIM | 渠道属于部署层 |

---

## 文档索引

| 路径 | 内容 |
|------|------|
| `docs/SSoT.md` | 文档入口 |
| `docs/ROADMAP.md` | 路线图 |
| `docs/ARCHITECTURE.md` | 本文 |
| `polaris.json` | 功能进度 |
| `decisions/` | ADR |
| `skills/` | 操作指南 |
