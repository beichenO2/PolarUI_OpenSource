---
name: polarui-workflow-authoring
description: >
  PolarUI 工作流撰写规范：规划状态机 → 拆分组件 → 补全缺失节点 → 递归检查循环 →
  完成 .lg.json → mock 测试 → 全链路测试。所见即所得：Harness = PolarUI 图本身。
  触发：写 workflow、新建工作流、PolarUI 图、lg.json、状态机 workflow、套辞 workflow。
---

# PolarUI Workflow 撰写

> **实施顺序**：文档 → 基础设施 → 具体 workflow（见 `docs/ARCHITECTURE.md`）  
> **架构必读**：`PolarUI/docs/ARCHITECTURE.md`、`PolarUI/decisions/`

## 核心原则

1. **所见即所得（WYSIWYG）** — 明面节点 + 连线 = 全部逻辑（ADR-001）
2. **Harness = `.lg.json` 图** — 不是 `harness/` CLI 文件夹（ADR-002）
3. **没有 ShellExec**（ADR-004）
4. **ToolCall = 复合组件** — tool list +「加载需要的工具」+ Switch 连明面工具节点（ADR-003）

## 现有 PolarUI Skills

| Skill | 路径 | 用途 |
|-------|------|------|
| **本 skill** | `PolarUI/skills/polarui-workflow-authoring/SKILL.md` | 七步撰写流程 |
| polarui-usage | `PolarUI/skills/polarui-usage/SKILL.md` | 启动 GUI |
| polarui-deploy | `PolarUI/skills/polarui-deploy/SKILL.md` | 部署 |
| polarui-troubleshoot | `PolarUI/skills/polarui-troubleshoot/SKILL.md` | 排查 |
| taoci-outreach | `PolarUI/skills/taoci-outreach/SKILL.md` | 套辞（阶段 C） |

## 参考

| 类型 | 文件 | 说明 |
|------|------|------|
| 多轮 | `dist/workflows/test-multi-turn-chat.json` | WorkingMemory → LLM |
| 套辞目标 | `workflows/taoci-outreach/WORKFLOW.spec.md` | 状态机 S0–S3 |
| **反例** | `workflows/taoci-outreach/taoci-outreach.lg.json` | ShellExec 黑盒，阶段 C 重写 |
| legacy | `dist/workflows/claude-code.lg.json` | 含 ShellExec，待迁移 |

详见 `references/wysiwyg-and-react.md`、`references/toolcall-composite.md`、`references/node-inventory.md`。

---

## 七步流程（必须按序）

### 1. 规划工作流 + 状态机

在 `{workflow-dir}/WORKFLOW.spec.md` 写清：

1. **一句话目标**
2. **状态机**（mermaid）：每状态含义、退出条件、可循环边
3. **多轮三要素**：
   - **状态控制**：`session.step`
   - **状态路由**：Switch / 条件边
   - **记忆**：WorkingMemory
4. **入站 / 出站**：FeishuIM 等
5. **验收**：GUI 能指出 LLM、记忆、路由、每条边

⛔ spec 里不得写「外部 harness 执行」— **Harness 就是图**。

### 2. 拆分组件，查缺

1. 状态/步骤 → `class_type` 映射表
2. 对照 `references/node-inventory.md`
3. 标记缺失节点（步骤 3 实现）

### 3. 编写缺失组件

仅步骤 2 确认缺失时：node-defs + executor + smoke。

⛔ 禁止 ShellExec、禁止 harness CLI 代替节点。

### 4. 递归检查循环

**WYSIWYG 检查清单：**

- [ ] 用户多轮环：入站 → WorkingMemory → Switch → step 节点 → 写回 memory → 出站
- [ ] ReAct（若有）：ToolCall（复合）→ **Switch → 明面工具节点** → 回 LLM
- [ ] 无 ToolCall executor 内 dispatch（deprecated）
- [ ] 无 ShellExec、无 `harness/index.mjs` 生产路径
- [ ] 无悬空节点
- [ ] RetryLoop 仅用于单步校验，非多轮对话

### 5. 完成 `.lg.json`

1. `{name}.lg.json` + 同步 `dist/workflows/`
2. 注册 `registry.json`
3. 飞书类：**FeishuIM** 出站（非 Notification）

### 6. Mock 测试

目录：`~/Desktop/测试/{workflow-name}/`

| 层 | 测什么 |
|----|--------|
| L1 | schema、单节点 |
| L2 | **图引擎**多轮 invoke |
| L3 | PolarClaw → **图引擎** → 出站 |

⛔ 禁止只 spawn `harness/index.mjs`。

**P0 断言：** 图含预期节点、WorkingMemory 有连线、无 ShellExec、`node_traces` 可解释。

### 7. 全链路测试

TEST-PLAN.md、cases、run-all.mjs；禁止 `checkpoint(..., true)` 硬 pass。

---

## 与 pc-principles

| 原则 | 要求 |
|------|------|
| P4 | spec 先于 .lg.json |
| P5b | `polaris.json` + `decisions/` + workflow spec |
| P2 | 测试报告标明图引擎 vs CLI |

---

## 套辞

阶段 C 实施。见 `skills/taoci-outreach/SKILL.md`。
