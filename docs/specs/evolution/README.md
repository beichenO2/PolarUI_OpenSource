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
