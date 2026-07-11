# 自进化体系设计稿（已归档）

本目录保留 ADR-010 决策 5 归档前的**设计规格**，不代表当前可运行实现。

双轨意图：

1. **Prompt 蒸馏轨** — `LearningCapture` / `ExperienceCapture` → `PromptEvolve` → `PromptInject` 跨 run 沉淀 prior knowledge
2. **图结构运行时变异轨** — `StemCell`（WF 权柄改主图）/ `PetriDish`（slave 子图分化）+ `RecursionGuard` 递归保护 + `HistorySink`/`HistoryReader` 可观测

| 文件 | 内容 |
|------|------|
| `evolve-node-defs.spec.json` | 原 `node-defs/evolve.json` 节点定义全集 |
| `evolution-loop.spec.json` | 原 `dist/workflows/evolution-loop.json` 元流水线 DAG |

实现已按 [ADR-010](../../decisions/010-single-engine-and-purity-refactor.md) 归档至 `~/Desktop/ClawBin/260710-polarui-evolution-archive/`。未来若重做，须 **TDD 从零开始**，不在现有半成品上迭代。

## 端到端演示（ADR-014 R10）

最小 headless 演示路径，**不回接 claude-code**（ADR-014 D4）。图文件位于 `workflows/evolve-demo/`，**无 `registry-entry.json`**，不会进入 `registry.json`。

### 怎么跑

```bash
cd PolarUI
npm run build          # 刷新 dist bundle（须含 StemCell / mutateGraph）
npm run demo:evolve    # 或 node scripts/evolve-demo.mjs
npm run qa             # 含 evolve-demo 步骤（共 13 步）
```

### 两图各证明什么

| 图 | 证明点 |
|----|--------|
| `stemcell-demo.json` | stepwise（`_entry`/`_lg_edges`）下 StemCell 通过 `differentiation_signal` 物化 StaticData 并 splice 进路径；后续步真正执行新节点；输出 `graph_edit_granted=true`、`materialized_class`、`materialized_data` |
| `petri-demo.json` + `slave-scorer.json` | PetriDish 在 slave 沙盒内对 3 个候选 `set_param` 变异并嵌套 `executeGraph` 打分；输出 `refined_workflow`（择优 score=10）、`evaluations`（含分数排序）、`applied=false`（恒 false，人审门控） |

演示脚本对 Petri 段从 `slave-scorer.json` 注入 `evolution_signal.slave_inline`（SSoT 文件仍为 `slave_workflow: evolve-demo/slave-scorer` 声明路径；headless bundle 的 fs polyfill 暂为空，磁盘 ref 加载待后续 vite 修复）。

演示脚本对 Petri 结果显式调用 `savePetriResult`（`lib/save-petri-result.mjs`），落盘 `workflows/evolve-demo/refined.petri.json`。

- `sync-workflows.mjs` **排除** `*.petri.json`，不会复制进 `dist/workflows`，也不会写入 `registry.json`
- 不生成 `registry-entry.json` —  refined 图需人工审核后，另存为带 registry-entry 的正式 workflow 才能注册
- `applied` 输出恒为 `false`；自动 apply 不在 R10 范围
