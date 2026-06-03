# PolarUI（开源版）

**ComfyUI 风格的可视化 Agent 工作流 IDE** — 双范式（WF 拓扑图 + LG 步进 Spec）、47+ 正则化节点、原生 ToolCall ReAct、PermissionGate、Validator + RetryLoop（默认 7 轮）。

本仓库是 [Polarisor](https://github.com/polarisor) 生态中 PolarUI 的**独立开源切片**：包含完整引擎、画布 UI、节点定义与工作流样例；可对接任意 OpenAI 兼容 LLM 网关（默认 `http://127.0.0.1:12790`）。

---

## 快速开始

```bash
npm install
npm run dev              # Vite 开发服务器 → http://127.0.0.1:5173
npm run test:claude-code # Claude Code 对照 smoke（mock LLM，无需网关）
```

**运行 Claude Code 工作流（需 LLM 网关）：**

```bash
# 网关须暴露 OpenAI 兼容 POST /v1/chat/completions，且支持 tools / function calling
npx tsx scripts/run-workflow-chat-once.mjs \
  --workflow claude-code-lg \
  --conversation-id demo \
  --message "读取 package.json，只回复 name 字段的值。"

# 四题对照实验复现（对比 benchmarks/claude-code/baseline/）
npx tsx scripts/run-claude-code-parity.mjs
```

**Electron 桌面版：**

```bash
npm run electron:dev
npm run electron:build   # 打包 macOS DMG
```

---

## 架构概览

| 层 | 路径 | 说明 |
|----|------|------|
| 画布 UI | `src/engine/canvas.ts`、Vue 组件 | 拖拽、连线、展开子图 |
| 执行引擎 | `src/engine/executor.ts` | 47+ 节点 `registerExecutor` |
| WF 执行 | `src/engine/workflow-runner.ts` | 拓扑排序 + 条件分支 |
| LG 执行 | `src/engine/lg-runner.ts` | `_lg_edges` 步进循环 + ReAct |
| 编译门 | `cli/compile-check.mjs` | 连线 / 类型 / 白名单校验 |
| 节点定义 | `node-defs/` | 组件面板 SSOT |
| 工作流库 | `workflows/` + `registry.json` | 预置 Agent Take |

**WF 与 LG 的区别**

- **WF**：ComfyUI 式冻结图，Switch / Condition 预先布线，适合确定性流水线。
- **LG**：LangGraph 式 Spec + Run，执行期可 Pluripotent 分化；`claude-code.lg.json` 是 Agent ReAct 参考实现。

---

## 有效性论述：Claude Code 对照实验

> 本节回答：**PolarUI 后置 UI 里组装的「Claude Code」工作流，能否在同等条件下产出与真实 Claude Code CLI 质量相当的 Agent 行为？**

### 1. 我们声称什么、不声称什么

| 我们声称 | 我们不声称 |
|----------|------------|
| 在**同一 LLM 后端**下，PolarUI `claude-code-lg` 对**工具型任务**的答案与 Claude Code CLI **质量等价** | PolarUI **不是** Claude Code 源码 fork，未嵌入 Anthropic 专有运行时 |
| ReAct 环（ToolCall → PermissionGate → 工具执行 → 回环）与 Claude Code **结构对齐** | 逐 token、延迟、费用与官方 CLI **完全一致** |
| 四题 benchmark **可复现、可自动判定** | 所有编程任务、所有模型上 **100% 等价**（换模型须重跑对照实验） |

### 2. 为什么用 Claude Code 作参照

Claude Code 是当前较完整的 **「LLM + 原生 function calling + 文件 / Shell 工具 + 权限门控 + 多轮 ReAct」** 参考实现之一。若 PolarUI 的可视化工作流在相同 LLM 下能复现其**任务完成质量**，则说明：

1. **引擎层**（`lg-runner.ts` + `executor.ts`）正确实现了 Agent 循环，而非仅 UI 壳；
2. **节点组合**（PromptInput → LLM → Switch → PermissionGate → ToolCall → Validator → RetryLoop → Output）具有**语义有效性**，不是 mock 演示；
3. PolarUI 作为 **Agent IDE 后置层** 有落地价值——用户可在画布上编辑 Claude Code 级 Agent，而不必锁定单一 CLI。

### 3. 实验设计（控制变量）

| 变量 | 设定 | 目的 |
|------|------|------|
| **LLM** | 模型码 `100`（GLM-5.1），经 PolarPrivate `/v1/chat/completions` | 消除模型差异；两边用**同一推理后端** |
| **Claude Code 侧** | `@anthropic-ai/claude-code --print --dangerously-skip-permissions` + 本地 anthropic→OpenAI 代理 | 可运行的官方 CLI 路径，非手工 mock |
| **PolarUI 侧** | `workflows/claude-code.lg.json`，registry id `claude-code-lg` | 画布可编辑的 LG Spec 工作流 |
| **无头权限** | `runContext.skip_permissions: true`（对齐 `--dangerously-skip-permissions`） | 排除交互审批对 benchmark 的干扰 |
| **判定** | 每题独立脚本 + 启发式 `expect()` + 人工抽检 | 可 CI 化，非主观「看起来差不多」 |

**四题 benchmark（覆盖能力维度）**

| 编号 | 能力维度 | 任务 | 期望答案 | 为何有效 |
|------|----------|------|----------|----------|
| q4-math | 纯推理（无工具） | `17×23+5` | `396` | 控制组：验证 LLM 链路与 Output 合并 |
| q2-package | FileRead + 精确抽取 | 读 `package.json` 的 `name` | `polar-ui` | 验证 native tool_calls → FileRead → 合成 |
| q1-folders | ShellExec / 目录枚举 | 列出项目顶层目录 + 一句摘要 | 含 `src`、`workflows` 等真实目录 | 验证多轮 ReAct + 文件系统工具 |
| q3-grep | GrepSearch + 计数 | 统计 `PermissionGate` 在 `claude-code.lg.json` 出现次数 | `3` | 验证搜索工具 + 整数精确输出 |

> 原始 monorepo 路径为 `PolarUI/...`；本开源包根目录即项目根，对照脚本已改为 `package.json`、`workflows/claude-code.lg.json` 等相对路径。baseline JSON 仍保留 monorepo 语境下的跑分，结论不变。

### 4. 实验结果

#### 4.1 真实 Claude Code CLI（基线）

数据见 `benchmarks/claude-code/baseline/`：

| 编号 | 结果 | 耗时 |
|------|------|------|
| q1-folders | ✅ 真实目录列表 | ~55s |
| q2-package-name | ✅ `` `polar-ui` `` | ~57s |
| q3-grep-count | ✅ `3`（针对 lg.json） | ~57s |
| q4-math-control | ✅ `396` | ~18s |

#### 4.2 PolarUI `claude-code-lg`（实验组）

数据见 `benchmarks/claude-code/polarui/polarui-lg-summary.json`：

```json
{
  "pass": 4,
  "total": 4,
  "results": [
    { "id": "q1-folders", "pass": true, "elapsed_ms": 149169 },
    { "id": "q2-package-name", "pass": true, "elapsed_ms": 46497 },
    { "id": "q3-grep-count", "pass": true, "elapsed_ms": 133402 },
    { "id": "q4-math-control", "pass": true, "elapsed_ms": 54501 }
  ]
}
```

**对照表**

| 题目 | Claude Code | PolarUI LG | 质量 |
|------|-------------|------------|------|
| q4 数学 | 396 | 396 | ✅ 一致 |
| q2 包名 | polar-ui | polar-ui | ✅ 一致 |
| q1 目录 | 真实目录 | 20 项真实目录 + 摘要 | ✅ 一致 |
| q3 grep | 3 | 3 | ✅ 一致 |

**结论：4/4 通过** — 在相同 LLM 后端下，PolarUI 工作流对四题的任务完成质量与 Claude Code CLI **等价**。

#### 4.3 典型样例（q2）

- 基线 stdout：`"result":"\`polar-ui\`"`
- PolarUI 输出：`"content": "\`polar-ui\`"`

两边均通过 FileRead 读取 manifest 并精确返回字段值，非模型臆造。

### 5. 实现要点（为何 v2 才通过）

早期 `claude-code-1to1.json`（WF + WhileLoop）仅通过**结构 smoke**（260524），**未**做质量对照。已证伪的缺陷包括：

1. ToolCall prompt 自指 RetryLoop → 空 prompt → `tool_calls: []`
2. LG Switch 在 JSON 解析失败时默认 `finish` → 跳过工具轨
3. WF WhileLoop executor 为 stub → 循环体不重入
4. Output 未绑定 `final_answer` → `merged_output` 为空

**v2 修复**（`claude-code.lg.json` + `lg-runner.ts`）：

```
PromptInput → PromptInject → ContextWindow → LLM（原生 tools）
  → Switch → PermissionGate → ToolCall → ReAct 回环
  → Validator → RetryLoop(7) → Output
```

- 原生 OpenAI `tool_calls` 解析（非 JSON branch 文本）
- `tool_args` 传入 FileRead / ShellExec / GrepSearch 执行器
- Switch 按 `state.branch` / `state.tool` 路由，不默认 finish
- `merged_output` 优先 `final_answer`，其次最后一条 assistant 消息

### 6. 局限性与后续验证

| 局限 | 说明 |
|------|------|
| 单模型 | 当前对照仅在 GLM-5.1 上完成；换模型须重跑 `run-claude-code-parity.mjs` |
| 四题覆盖 | 不代表长程编码、多文件重构、MCP 全量工具 |
| 延迟 | PolarUI 路径约 46s–149s/题，高于 CLI（多一层 LG 步进 + Validator） |
| 生态工具 | KnowLever / SSoT / Hub 等节点需 Polarisor 后端；本仓库可 mock 或 HTTP 对接 |
| 交互 UI | 画布内 PermissionGate 仍可对非白名单工具弹审批；benchmark 使用 `skip_permissions` |

**建议扩展 benchmark**：多文件编辑、git commit、SubAgent 委托、失败重试触发 RetryLoop。

### 7. 复现步骤

```bash
# 1. 安装依赖
npm install

# 2. 启动 OpenAI 兼容网关（示例：PolarPrivate 12790，或任意支持 tools 的 endpoint）
#    端口可在 src/sdk/llm-proxy.ts 中修改 LLM_PROXY_PORT（默认 12790）

# 3. Mock smoke（无需网关）
npx tsx scripts/run-claude-code-lg-smoke.mjs

# 4. 在线对照实验（需网关 + vault 解锁）
npx tsx scripts/run-claude-code-parity.mjs
# 输出 → benchmarks/claude-code/polarui/
```

如需重跑 Claude Code CLI 基线，见 `benchmarks/claude-code/README.md`（需 `@anthropic-ai/claude-code` + anthropic 代理 shim）。

---

## 目录结构

```
PolarUI_OpenSource/
├── src/engine/          # 核心：canvas、executor、lg-runner、compile-check
├── node-defs/           # 节点面板定义（已打包）
├── workflows/           # WF/LG JSON + registry.json
├── scripts/             # 无头 smoke / 对照实验 / 单次 chat
├── benchmarks/claude-code/
│   ├── baseline/        # 真实 Claude Code 跑分（冻结）
│   └── polarui/         # PolarUI 对照跑分
├── cli/                 # compile-check CLI
├── electron/            # 桌面壳
└── skills/              # polarui-component / workflow / planner
```

---

## 与 Polarisor 生态的关系

本仓库**可独立运行**引擎与 UI。以下能力在完整生态中增强，但**非**开源包必需：

- **PolarPrivate** — LLM / Vault 网关（可替换为任意 OpenAI 兼容 API）
- **PolarCopilot Hub** — Web Agent 面板、`/api/ui/*`
- **SSoT / polaris.json** — 多项目生态地图（完整版见 Polarisor monorepo）

---

## 许可证

MIT — 见 [LICENSE](./LICENSE)。

Claude Code 为 Anthropic 产品；本仓库 benchmark 仅作**对照实验**，不包含 Claude Code 源码或商标授权。
