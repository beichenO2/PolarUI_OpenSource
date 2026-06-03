---
name: polarui-component
description: >-
  PolarUI 正则化组件（node-def + registerExecutor）创建与维护规范。
  触发：新建组件、改 executor、node-defs、registerExecutor、组件注释、Agentic 范式。
---

# PolarUI 组件编写与维护（SSOT）

> 适用范围：`node-defs/*.json` 中的节点定义，以及 `PolarUI/src/engine/executor.ts`（或 `pipeline-executor.ts` 等）中的 `registerExecutor` 实现。  
> 关联：`PolarUI/.cursor/skills/polarui-workflow/SKILL.md`（工作流编排）、`PolarUI/.cursor/skills/polarui-planner/SKILL.md`（规划用组件清单）、`任务书/Done/260523_整理归档/260523/00_PolarUI_口径与设计整合.md`。

---

## 强制注释规范（Hub 2026-05-31）

编写或修改组件实现代码时，**必须**满足以下四条（缺一不可）：

| # | 规则 | 示例 |
|---|------|------|
| 1 | **每一个条件判断**都要有注释 | `if (x) {  // 判什么；真/假分支各意味着什么`（**行尾**） |
| 2 | **每一个循环**都要有注释 | `for (...) {  // 遍历谁、终止条件、与业务关系` |
| 3 | **每一个变量赋值**都要有注释 | `const q = inputs.query  // 来自哪槽、作何用` |
| 4 | **每一个变量的计算**都要有注释 | 含 `??`、`JSON.parse`、三元式；说明**数据流意图** |

### 写法要求（Hub 2026-05-31 修订）

- **单一 SSOT**：注释只写在 `executor.ts`（或 pipeline）源文件**行尾**；侧栏「组成代码」直接读 `?raw`，禁止 UI 层二次改写。
- **首行必须可读**：`registerExecutor('X', …) => {  // 显示名 | 入:槽 出:槽 → 核心动作（HTTP/子图/工具）`
- 注释必须让读者看出：**输入从哪来、输出是什么、中间步骤在干什么**；禁止 `xxx业务中间量`、`条件分支` 等空泛句。
- 条件/循环/赋值均在**同一行行尾**写 `// …`；复杂 `fetch` 可在多行配置对象的关键字段行尾补槽位说明。

### 禁止

- 无注释的 `if` / `for` / `const` / `let`。
- 独立一行的 `//`（须合并到代码行尾）。
- UI 展示层 `formatSnippetCommentsInline` 等「双事实源」改写。
- 空泛占位注释（`业务中间量`、`条件分支`、仅复述语法）。

### 验收（自查）

- [ ] 通读 diff：搜索 `if (`、`for (`、`while (`、`const `、`let `，确认相邻有注释
- [ ] `npm run build`（PolarUI）
- [ ] 涉及接线规则时跑 `node cli/compile-check.mjs` 或相关 smoke

---

## 组件交付清单

1. **node-def**（或 `registry.json` 内 `paradigm_*` + `node_def`）  
   - `inputs` / `outputs` 每项含 `description`  
   - `display_name`、`description` 对用户可读  
2. **registerExecutor**（或 pipeline internal_workflow）  
   - 满足上文四条注释规范  
   - 错误信息中文、可定位到槽位/参数  
3. **registry**（若为已注册范式）  
   - 条目在 `PolarUI/workflows/registry.json`，`category` 与首字母排序一致  
4. **测试**  
   - 能编入现有 gate / smoke 则接入；至少本地 `compile-check` 通过  

---

## 注册与 Palette

- 原子组件：`node-defs` + `index.json` 引用  
- Agentic 范式：**SSOT 为 `registry.json`**（`paradigm_class_type` + `node_def`）；引擎加载 `node-defs/registry-paradigms.json`  
- **不要**再新增独立 `agentic.json`  

---

## 注释补全进度（executor 分批）

- [x] **批次 1**：`LLM`、`Condition`、`Switch`、`RetryLoop`、`ForLoop`、`WhileLoop`、`AgentWorkflow`（pipeline）
- [x] **批次 2**：`ToolCall`、`Validator`、`TextTransform`、`JsonParse`、`Merge`、`StaticData`、`PromptInput`、`Output`、`SampleLoop`、`MapReduce`、`PromptInject`、`HumanApproval`、`RegexMatch`
- [x] **批次 3+**：`executor.ts` 自 L655（`createApiExecutor`/Clock/生态 HTTP/File·Shell·Git/Agentic/Checkup 等）及 `pipeline-executor.ts` 全量；脚本 `scripts/annotate-executor-comments.mjs`（幂等）

---

## 参考实现

- 画布展示：`PolarUI/src/engine/canvas.ts` → `drawNode`、`wrapGraphLines`（图坐标断行，缩放只影响绘制字号）  
- 连线标签：同文件 `drawWireSlotLabels`（与组件相同 Canvas + scale）  
- 编译门：`PolarUI/src/engine/routing-branch-check.ts`（Switch/Condition 至少 2 路）
