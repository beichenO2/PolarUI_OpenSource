# ADR-014 自进化重建：干细胞与培养皿（TDD 从零）

- 状态：accepted
- 日期：2026-07-10
- 前置：ADR-010 P4（旧自进化归档）、ADR-011（服务 B 定位）、ADR-002（Harness 即图）
- 设计稿：`docs/specs/evolution/`（节点 IO 契约以此为准）
- 进度追踪：`polaris.json` **R10**

## 背景

旧自进化系统（StemCell / PetriDish / PromptEvolve / evolution-loop）确认不可运行，
已归档 ClawBin。用户决策（2026-07-10 Hub）：重建**两种**结构进化原子——
干细胞（StemCell）与培养皿（PetriDish）。Prompt 蒸馏轨（PromptEvolve）不在本次范围。

## 决策

### D1 变异内核 = 纯函数层（先行单测）

新建 `src/engine/graph-mutation.ts`，与执行器解耦：

- `MutationOp`：`add_node | remove_node | add_link | remove_link | set_param`
- `applyMutations(workflow, ops, policy) → { workflow, applied, rejected, audit }`
- `policy = { allowedTypes, maxNodes, protectedNodeIds }`
- 不变量：无悬空边；class_type 白名单；节点数预算；受保护节点（入口/Output）
  不可删除；违规 op 进 `rejected` 不中断整批。

### D2 干细胞（StemCell）= 主图运行时权柄

- IO 按 spec：`state + differentiation_signal → state + materialized_class +
  node_id + graph_edit_granted`。
- `differentiation_signal` 承载 MutationOp[]（或 `{materialize, params}` 便捷形态）。
- 执行器通过 runner 注入的 `context.mutateGraph(ops)` 改**当前运行图**；
  步进引擎每步重读图，新增节点在后续步骤可被执行。
- 护栏内置为节点参数（不再单独 RecursionGuard 节点）：`allowed_types`、
  `max_mutations`（每 run 变异预算）、超预算拒绝并输出 `graph_edit_granted=false`。
- 变异只作用于内存中的运行图；**不自动持久化**主图文件。

### D3 培养皿（PetriDish）= 沙盒子图分化

- IO 按 spec：`seed + evolution_signal → refined_workflow + applied`。
- 加载 `slave_workflow`（workflows/ 路径）→ 深拷贝为沙盒 → 应用候选变异 →
  在沙盒内执行评估（mock 可跑）→ 输出最优 `refined_workflow`。
- **绝不触碰主图**；`applied` 恒为 false，除非显式 `auto_apply=false`（默认）被
  人工置位。持久化走独立函数 `savePetriResult(workflow, name)` 写
  `workflows/<name>.petri.json` 供人审注册，不自动进 registry。

### D4 注册面

- 新增 `node-defs/evolve.json`：仅 StemCell、PetriDish 两节点（不带旧名
  PluripotentCell 兼容——无旧实现原则）。index.json 同步（5→6 文件）。
- 不回接 claude-code 图；提供测试 fixture 演示。

## 验收（QA 门禁）

- `tests/engine/graph-mutation.test.ts`：白名单/预算/悬空边/保护节点/批量部分拒绝。
- `tests/engine/stemcell.test.ts`：步进 fixture 中 StemCell 运行时加节点，
  引擎在后续步骤执行了新节点；超预算拒绝路径。
- `tests/engine/petri-dish.test.ts`：沙盒产出 refined_workflow，主图哈希不变；
  savePetriResult 落盘不进 registry。
- `npm run qa` 全绿；vue-tsc 0 错误。
