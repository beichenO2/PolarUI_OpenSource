# ADR-012 Workflow HTTP 插拔（`/run` 契约）

- 状态：accepted
- 日期：2026-07-10
- 前置：ADR-008（Web 发行版）、ADR-007（记忆三层）、ADR-011（双服务定位）

## 背景

同一业务（如 market-truth 情报客服）曾出现 **JS builtin 适配器**与 **Python LangGraph 主项目**两套实现：语义约 60–70% 对齐，但算法迭代无法共用，Web 与 benchmark 分裂。

调研对比三条路线（见发行版 `WORKFLOW_PLUGGABILITY.md` §6）：

| 方案 | 概要 | 结论 |
|------|------|------|
| A. 强化 builtin 契约 | export 生成 stub `.mjs` | 短期有用，仍要手写业务 |
| **B. 外置 HTTP** | 任意语言暴露 `POST /run`；polar 通用 fetch | **采纳** |
| C. 仅 graph-cli | 画布 = 唯一运行时 | 复杂 Skill 难图表达，不适合 market-truth |

用户定调（2026-07-10）：HTTP 插拔是 **Demo 验证的设计约束**，主设计落在 PolarUI——**只要实现 `/run` 契约就能插进 Web**；怎么插写成 skills，写入 PolarUI 文档与 Roadmap。

## 决策

### D1 `/run` 为一级插拔约束

任何语言/框架，只要实现 [`docs/WORKFLOW_RUN_CONTRACT.md`](../docs/WORKFLOW_RUN_CONTRACT.md) 中的请求/响应 JSON，即可经 `site.config.json` → `http_workflows[]` 接入 PolarChat，**无需改 polar 核心**（`process-chat` / `openai-compat` / LibreChat 集成层）。

### D2 三路分发

`registry.resolveWorkflow`：**builtin → http → graph-cli**。id 冲突时 builtin 优先。

### D3 通用适配器，不按业务写 fetch

`polar/lib/http-workflow.mjs`：`createHttpWorkflowRunner(spec)` 原样转发 `run()` 入参；超时/网络/非法 JSON → `{ ok:false, reply:'工作流服务暂时不可用（…）' }`，Chat UI 友好降级。

### D4 验证结论（Phase 1）

已在 `_template` + `market-truth-cs` 验证：

| 项 | 证据 |
|----|------|
| 适配器 + 单测 | `_template/polar/lib/http-workflow.mjs` · `polar/tests/unit/http-workflow.test.mjs` |
| 契约示例 | `examples/http-workflow-demo/`（Node `:3941`） |
| Python 真实服务 | `雷老师组测试任务/service/` → `mta-python` `:3945`，与 cheatAgent 同核 |
| 配置 | `http_workflows[]` + `librechat.yaml` modelSpecs preset |

Phase 1 = **适配器 + 契约 + 配置插拔**已跑通。PolarUI 主仓后续能力见 Roadmap R7（export 直出、画布 HTTP 节点、鉴权、history 标准化等）。

## 后果

- 正面：Python/JS/其他语言算法一处迭代；Web 壳与业务运行时解耦；插拔边界可文档化、可 skill 化。
- 负面：多一跳网络与部署；当前明文无鉴权，仅适内网；会话 history 默认服务自管（开放问题）。
- 回滚：去掉 `http_workflows` 条目即可回退 builtin / graph-cli，核心路径不变。

## 关联

- 契约：`docs/WORKFLOW_RUN_CONTRACT.md`
- Skills：`polarui-workflow-contract` · `polarui-web-deploy`
- Roadmap：`docs/ROADMAP.md` · R7 · `polaris.json`
