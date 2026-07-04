# PolarUI 架构原则

> **SSoT**：本文 + `decisions/` + `polaris.json`  
> **实施顺序**：文档（本阶段）→ 基础设施 → 具体 workflow（如 taoci-outreach）

---

## 1. 所见即所得（WYSIWYG）

**图上能看见的明面组件 = 全部业务逻辑。**

- 状态机、路由、LLM、工具、记忆、出站 — 必须在 `.lg.json` 节点与连线上可读
- 禁止把逻辑藏在 executor 内部、外部 CLI、或未连线的占位节点
- GUI 单步 trace 应能解释「这一步发生了什么、为什么走这条边」

详见 [ADR-001](./../decisions/001-wysiwyg-principle.md)。

---

## 2. Harness = PolarUI 图

**Harness 不是文件夹，是 workflow 图本身。**

| 正确 | 错误 |
|------|------|
| `taoci-outreach.lg.json` 含 WorkingMemory → Switch → LLM → FeishuIM | `workflows/.../harness/index.mjs` 外包状态机 |
| PolarClaw `@套辞` → 调 **graph engine** 执行 `.lg.json` | PolarClaw `spawnSync('node', harness/index.mjs)` 绕过图 |
| 测试断言 `node_traces` 含预期 class_type | 只测 harness CLI stdout |

详见 [ADR-002](./../decisions/002-harness-is-the-graph.md)。

---

## 3. 没有 ShellExec

PolarUI workflow **不存在 ShellExec 组件**（不是隐藏，是不存在）。

- 不得用终端命令节点代替缺失能力
- 不得 `node harness/*.mjs` 或任意 shell 外包
- legacy 图 / node-defs 中的 ShellExec 待从 workflow 范式中移除（基础设施阶段）

详见 [ADR-004](./../decisions/004-no-shellexec.md)。

---

## 4. ToolCall = 复合组件（对齐 PolarClaw）

ToolCall 是**图上的复合节点**，不是「在 executor 里偷偷 dispatch 工具」的黑盒。

对齐 PolarClaw Agent 的工具模型：

| PolarClaw | PolarUI ToolCall（目标） |
|-----------|-------------------------|
| 常驻 `tools.list()` | 节点 params / GUI 可见的 **工具列表** |
| `skill_search` | 元工具：**搜索可用技能/工具** |
| `skill_activate` | 元工具：**加载需要的工具** → 扩充工具列表 |
| `tools.execute(name, args)` | Switch 连到 **明面工具节点**（FileRead、WebSearch、SubAgent…）执行 |
| `runLoop` ReAct | LLM → Switch → ToolCall / 工具节点 → 回 LLM |

**ReAct 工具执行**：Switch 的边连到图上的 FileRead、WebSearch、SubAgent 等节点 — **逻辑在边上，不在 ToolCall executor 内部**。

Skill 执行：通常仍在同一 ReAct 环；若需子 Agent 级嵌套，用 **SubAgent** 或子图在图上显式表达。

详见 [ADR-003](./../decisions/003-toolcall-composite-component.md)、`skills/polarui-workflow-authoring/references/toolcall-composite.md`。

---

## 5. 已废弃方案（勿再引用）

| 方案 | 状态 | 说明 |
|------|------|------|
| ToolCall executor 内部分发（`lib/tool-dispatch.mjs`、`W5t()` patch） | **deprecated** | 违反 WYSIWYG；基础设施阶段移除 |
| ShellExec `palette_hidden` + ToolCall 内调 | **deprecated** | ShellExec 不应存在 |
| 「禁止 Switch 并列工具节点」 | **deprecated** | 与 WYSIWYG 相反；Switch→明面工具节点才是正途 |

旧 ADR：`decisions/001-toolcall-internal-dispatch.md`（已 superseded）。

---

## 6. 实施路线图

### 阶段 A — 文档

- [x] `docs/ARCHITECTURE.md`、`decisions/`、`polaris.json`、skills 对齐上述原则
- [ ] `WORKFLOW.spec.md` / 任务书交叉引用更新

### 阶段 B — 基础设施（约 90%）

- [x] 移除 ToolCall 内部分发（W5t patch、`tool-dispatch.mjs`）
- [x] `lib/headless-engine.mjs` — 轮询 node-defs 就绪 + overlay executor 注册
- [x] `lib/run-graph.mjs` — headless executeGraph（经 headless-engine，非固定 sleep）
- [x] `lib/toolcall-graph/register.mjs` — ADR-003 runtime overlay（intent-only LLM + `_lg_edges` 路由）
- [x] `scripts/patch-toolcall-executor.mjs` — bundle ToolCall 产出 branch/tool/tool_list，不内部分发
- [x] `npm run build` 后自动 `patch:lg-runner` + `patch:toolcall`
- [x] `test-lg-react-replay.lg.json` — Switch→明面工具节点条件路由 + 图引擎测试
- [x] claude-code / hermes / hermes-react-replay / polarclaw-feishu `_lg_edges` 工具路由
- [ ] ToolCall GUI 复合组件（工具列表编辑器）
- [ ] 独立 headless bundle entry（避免 Vue mount 副作用）

### 阶段 C — 具体 workflow（完成）

- [x] 重写 `taoci-outreach.lg.json`（Switch + LLM/SubAgent + FeishuIM，无 ShellExec）
- [x] `lib/taoci-graph/` 明面节点 executor（TaociSessionLoad/Save/SubAgent）
- [x] LG 条件边单路径执行（`scripts/patch-lg-runner.mjs` → LX 委托 S4t）
- [x] 删除 `workflows/taoci-outreach/harness/`；逻辑在 `lib/taoci-graph/`
- [x] 测试全改跑图引擎（state-machine + huyoucai-qa 多轮情景）

---

## 7. 文档索引

| 路径 | 内容 |
|------|------|
| `polaris.json` | 功能进度 |
| `decisions/README.md` | ADR 索引 |
| `skills/polarui-workflow-authoring/SKILL.md` | 七步撰写流程 |
| `skills/polarui-workflow-authoring/references/wysiwyg-and-react.md` | WYSIWYG + ReAct 图结构 |
| `skills/polarui-workflow-authoring/references/toolcall-composite.md` | ToolCall 与 PolarClaw 对照 |
| `skills/taoci-outreach/SKILL.md` | 套辞专项 |
