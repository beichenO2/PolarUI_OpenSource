# ADR-002：Harness 即 workflow 图本身

**日期**：2026-07-04  
**状态**：accepted（2026-07-04 修订：去掉错误的 ToolCall 内 dispatch 表述）

## 背景

taoci-outreach 曾用 `PromptInput → ShellExec(harness/index.mjs) → Output`：业务在图外 CLI，PolarUI 图不可解释；PolarClaw 用 `spawnSync` 绕过 graph engine。

## 决策

1. **Harness = `.lg.json` 图** — 状态机、LLM、SubAgent、FeishuIM、WorkingMemory 等**必须在图上可见**。
2. **禁止外挂 harness CLI** — `workflows/*/harness/index.mjs` 不得作为生产路径；过渡期仅可作 mock 夹具，且须标注 deprecated。
3. **PolarClaw 等通道** — 触发 workflow 时调用 PolarUI **graph engine**（`executeGraph`），输入 conversation/message，读 Output/FeishuIM 出站；**不得** spawn 外挂 CLI。
4. **测试** — L2/L3 必须断言图引擎 `node_traces`，不得只测 harness stdout。

## 「调 graph engine」含义

| 现在（错） | 目标（对） |
|------------|------------|
| `taoci-route.ts` → `spawnSync('node', harness/index.mjs)` | `taoci-route.ts` → PolarUI `executeGraph(taoci-outreach.lg.json, inputs)` |
| 逻辑在 `harness/state-machine.mjs` | 逻辑在 `.lg.json` 节点与边 |

## 后果

- taoci-outreach 重写：`WorkingMemory → Switch(step) → LLM/SubAgent → FeishuIM → Output`
- `harness/` 文件夹逻辑上浮到图后删除或仅留测试 mock
- `WORKFLOW.spec.md` 架构图以 `.lg.json` 为准

## 参考

- `任务书/260703/套辞workflow.md`
- `PolarClaw/src/adapters/channel/taoci-route.ts`（待改，基础设施阶段）
