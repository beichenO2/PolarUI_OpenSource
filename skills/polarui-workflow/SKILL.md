---
name: polarui-workflow
description: >-
  PolarUI 工作流 JSON（WF）手写创建与维护规范。
  触发：新建工作流、改 workflow JSON、registry 注册、compile-check、RetryLoop 编排。
---

# PolarUI 工作流编写与维护（SSOT）

> 适用范围：`PolarUI/workflows/*.json` 及 `workflows/registry.json` 注册条目。  
> 关联：`PolarUI/.cursor/skills/polarui-component/SKILL.md`（缺节点先建组件）、`PolarUI/.cursor/skills/polarui-planner/SKILL.md`（LLM 自动生成 WF）、`任务书/Done/260523_整理归档/260523/00_PolarUI_口径与设计整合.md`。

**与 Planner 的边界**：本 Skill 管**手写 / 维护** workflow JSON + registry + 编译门；Planner 管 **LLM 自动生成**逻辑链。Planner 产出仍须按本 Skill 验收。

---

## 0. 执行模式

| 模式 | 文件 | 执行引擎 |
|------|------|----------|
| **WF** | `*.json` | `executeGraph`，拓扑 DAG（可含回边） |

- registry 条目含 `"library": "WF"`。

---

## 1. JSON 契约（ComfyUI 同构）

```json
{
  "1": {
    "class_type": "PromptInput",
    "inputs": {
      "content": "用户任务描述",
      "expected_output": { "body": "^\\{.*\"title\".*\\}$" },
      "purpose": "本工作流要达成的用户需求（Validator SSOT）"
    }
  },
  "2": {
    "class_type": "LLM",
    "inputs": { "prompt": ["1", 0] },
    "params": { "model": "qwen3" }
  }
}
```

| 字段 | 规则 |
|------|------|
| 节点 id | 字符串键 `"1"`, `"2"`, …；`_` 前缀为元数据键 |
| `class_type` | 必须已在 `node-defs` / registry 注册；**禁止** `palette_hidden` / `Internal/*` 节点 |
| `inputs` | 字面量或连线 `["源节点id", 输出槽索引]` |
| `params` | 节点参数；与 inputs 分工见 node-def |
| 元数据 | `_name`、`_description`、`_category`（可选，便于 smoke / 文档） |

### PromptInput 必填（compile-check 硬门）

- `expected_output`：**JSON 对象**，键 = 分块名，值 = **非空正则字符串**（如 `{ "body": "^..." }`）
- `purpose`：对齐 **用户需求** 的自然语言 SSOT（Validator / RetryLoop 轮间验收锚点）

---

## 2. 默认范式：RetryLoop 优先

凡含 **LLM 且产出可核验**，默认编排（除非用户或任务书明确豁免）：

```
PromptInput(用户需求 + expected_output + purpose)
  → … → LLM
  → Validator(对齐 purpose / expected_output，非报告勾选)
  → RetryLoop(max_retries=7)
       ↑ retry_input 回边到 LLM.prompt（或上游需修正的槽）
  → Output
```

| 层级 | 语义 |
|------|------|
| **轮内** | 发现问题就改、改完再查，直到相对用户需求无问题 |
| **轮间** | 刷新上下文，从 **用户需求 SSOT** 重新验收；**禁止**把 stderr / error log 贴进下一轮 prompt |

**参考**：`workflows/test-retry-loop-backedge.json`、`workflows/01-rag-report.json`

### 控制流三件套（共存，不同层级）

| 节点 | 层级 | 说明 |
|------|------|------|
| **RetryLoop** | 单次 `executeGraph` 内 | 反馈重跑；与 Cron / RecursionGuard **正交** |
| **Cron** | 跨 run | 定时启动整图（如 `evolution-loop`） |
| **RecursionGuard** | 跨 run | 自调用前门禁；可与 `AgentWorkflow(self)` 并存 |

---

## 3. 分支与接线门控

- **Switch / Condition**：至少 **2 路** 出边（`routing-branch-check` / `compile-check.mjs`）
- **wire-integrity**：槽位类型兼容、引用节点存在
- **孤立节点**：无连线会 warning（`NoteCard` 除外）

---

## 4. 工作流交付清单

1. **JSON 文件** — `PolarUI/workflows/<kebab-name>.json`
2. **registry 条目** — `PolarUI/workflows/registry.json`（按 `category` + 首字母排序插入）  
   必填字段示例：

   ```json
   {
     "id": "<uuid>",
     "name": "人类可读名称",
     "description": "一句话说明链路",
     "category": "mind-audit | ssot | polarclaw | test | …",
     "nodeCount": 9,
     "file": "01-rag-report.json",
     "library": "WF",
     "registeredAt": "<ISO8601>",
     "updatedAt": "<ISO8601>"
   }
   ```

3. **编译门**

   ```bash
   node cli/compile-check.mjs workflows/<file>.json
   node cli/compile-check.mjs --all          # 全量
   node cli/compile-check.mjs --all --strict # warnings 亦失败
   ```

4. **冒烟**（按 category 接入既有 gate，如 `test-mind-audit/`、`npm run test:gate:*`）

---

## 5. 与 polarui-component 的分工

| 场景 | 用哪个 Skill |
|------|----------------|
| 编排**已有** `class_type` | **本 Skill** |
| 需要**新**节点类型 / executor | **polarui-component** → 再回本 Skill 编排 |
| Agentic 复合组件（`internal_workflow`） | 两者都要：组件内嵌子图 + 外层 registry |
| LLM 从目标**自动生成** WF | **polarui-planner** → 产出仍须本 Skill 验收 |

---

## 6. 常见 category 与示例

| category | 用途 | 示例文件 |
|----------|------|----------|
| `mind-audit` | 心智审计标准 WF | `01-rag-report.json` … `10-agentic-chain-debug.json` |
| `ssot` | 生态 SSoT 操作 | `ssot-up-to-date.json` |
| `polarclaw` | PolarClaw 预制工作流 | `polarclaw-ide.json` |
| `test` | smoke / 回归 | `test-retry-loop-backedge.json` |

---

## 7. 验收（自查）

- [ ] `node cli/compile-check.mjs <file>` → **0 errors**
- [ ] `registry.json` 的 `file` / `library` / `nodeCount` 与实际一致
- [ ] 含 LLM 的可核验链路 → **Validator + RetryLoop(7)** + 回边完整
- [ ] 每个 `PromptInput` 有 `expected_output`（JSON 正则分块）+ `purpose`
- [ ] Switch / Condition ≥ 2 路
- [ ] 缺节点类型时已走 **polarui-component**，非硬编未注册 `class_type`

---

## 8. 参考实现

- 编译门：`PolarUI/cli/compile-check.mjs`、`cli/wire-integrity-check.mjs`
- 分支检查：`PolarUI/src/engine/routing-branch-check.ts`
- 执行：`PolarUI/src/engine/workflow-runner.ts`、`executor.ts`
- 口径 SSOT：`任务书/Done/260523_整理归档/260523/00_PolarUI_口径与设计整合.md`
- RetryLoop 原则：`任务书/Done/260523_整理归档/260523/13_RetryLoop_Agent优先原则.md`
