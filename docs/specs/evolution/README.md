# 自进化体系设计稿（已归档）

本目录保留 ADR-010 决策 5 归档前的**设计规格**，不代表当前可运行实现。

双轨意图：

1. **Prompt 蒸馏轨** — `LearningCapture` / `ExperienceCapture` → `PromptEvolve` → `PromptInject` 跨 run 沉淀 prior knowledge
2. **图结构运行时变异轨** — `StemCell`（WF 权柄改主图）/ `PetriDish`（slave 子图分化）+ `RecursionGuard` 递归保护 + `HistorySink`/`HistoryReader` 可观测

| 文件 | 内容 |
|------|------|
| `evolve-node-defs.spec.json` | 原 `node-defs/evolve.json` 节点定义全集 |
| `evolution-loop.spec.json` | 原 `dist/workflows/evolution-loop.json` 元流水线 DAG |

实现已按 [ADR-010](../../../decisions/010-single-engine-and-purity-refactor.md) 归档至 `~/Desktop/ClawBin/260710-polarui-evolution-archive/`。未来若重做，须 **TDD 从零开始**，不在现有半成品上迭代。

## 端到端演示（ADR-014 R10）

两套 headless 演示：**隔离 fixture**（`demo:evolve`）与 **真实 claude-code**（`demo:evolve-claude`，2026-07-12 修订）。均**无 `registry-entry.json`**，不会进入 `registry.json`。

### 怎么跑

```bash
cd PolarUI
npm run build               # 刷新 dist bundle（须含 StemCell / mutateGraph）
npm run demo:evolve         # 隔离 fixture（stemcell-demo + petri-demo）
npm run demo:evolve-claude  # 真实 claude-code 宿主 + slave（mock LLM）
npm run qa                  # 含 evolve-demo + evolve-claude-demo 两步
```

### Mock 环境（claude-code 演示）

| 变量 | 值 | 作用 |
|------|-----|------|
| `POLARUI_MOCK_LLM` | `1` | 覆盖 LLM executor，无需 API key |
| `POLARUI_MOCK_LLM_BRANCH` | `finish` | Switch 走 finish→Validator→Output 路径 |

### 隔离 fixture（`demo:evolve`）

| 图 | 证明点 |
|----|--------|
| `stemcell-demo.json` | stepwise 下 StemCell 物化 StaticData 并 splice；`graph_edit_granted=true` |
| `petri-demo.json` + `slave-scorer.json` | PetriDish 三候选 `set_param` 打分；`refined_workflow` 择优 score=10；`applied=false` |

Petri 段从 `slave-scorer.json` 注入 `evolution_signal.slave_inline`；结果落盘 `workflows/evolve-demo/refined.petri.json`。

### 真实 claude-code（`demo:evolve-claude`）

| 段 | 证明点 |
|----|--------|
| StemCell | 读磁盘 `claude-code.json`→内存拷贝；在 `_lg_edges` 4→5 间 splice StemCell；`differentiation_signal` 物化 StaticData 注解节点；mock finish 跑通至 Output；`graph_edit_granted=true` |
| PetriDish | `slave_inline` 注入 claude-code 拷贝（含 `petri_sc` 打分 StemCell + `petri_gate`）；三候选：0=坏类替换 gate（`ok=false`）、1/2=调 `state.score`（3/10）；择优 score=10；`applied=false` |

打分：`petri_sc`（StemCell，`allow_graph_edit=false`）在 lg 路径 6→7 间输出 `state.score`；`extractNumericScore` 从 `merged_output.score` 读取。结果落盘 `workflows/evolve-demo/refined-claude.petri.json`。

**磁盘 `workflows/claude-code/claude-code.json` 不被修改**；变异仅在运行内存 / slave 沙盒内。

### 人审门控（两演示共用）

- `sync-workflows.mjs` **排除** `*.petri.json`，不会复制进 `dist/workflows`，也不会写入 `registry.json`
- 不生成 `registry-entry.json` — refined 图需人工审核后，另存为带 registry-entry 的正式 workflow 才能注册
- `applied` 输出恒为 `false`；自动 apply 不在 R10 范围
