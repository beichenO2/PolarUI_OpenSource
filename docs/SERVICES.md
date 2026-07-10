# PolarUI 双服务定位（ADR-011）

> PolarUI 对外只提供两种服务。所有节点、workflow、文档、测试都必须能回答
> "属于服务 A 还是服务 B"，否则不属于 PolarUI。

## 服务 A · Agent 搭建（ClaudeCode 类）

从 **LLM + 正则化/结构化抽取** 开始，逐步搭建完整 Agent 体系。

- **原子**：`node-defs/core.json`（LLM、RegexMatch、SchemaExtract、ToolCall、
  ContextWindow、PromptInject、Switch、Validator、RetryLoop、PermissionGate…）
  + `node-defs/tools-system.json`（FileRead/Write、Glob/Grep、WebSearch、MCPCall、
  SubAgent、CodeExec…）
- **参考实现**：[`workflows/claude-code/claude-code.json`](../workflows/claude-code/)
  —— 26 节点 ClaudeCode 复现图，也是仓库**唯一注册 workflow**、QA e2e 的黄金样例。
- **典型路径**：PromptInput → ContextWindow → LLM → Switch →（ToolCall → 工具 →
  回环）→ Validator → Output。
- **验证**：`node lib/run-graph-cli.mjs --workflow claude-code ...`（mock 可跑）。

## 服务 B · Agentic Workflow 搭建（Dify 类自进化）

以 **ClaudeCode 型 Agent 为原子 + Harness（图本身，ADR-002）** 编排工作流，
目标是自进化的 Agentic 系统。

- **原子**：`node-defs/paradigms.json`（AgentWorkflow、AgenticUnit、AgenticChain、
  Planner、WorkflowMeta、SelfHealUnit）+ `node-defs/polar-memory.json`（三层记忆，
  ADR-007）。
- **自进化**：旧实现已归档（ADR-010 P4），设计稿在
  [`specs/evolution/`](./specs/evolution/)；将在服务 A 地基上按新契约重建，
  不复活旧代码。
- **状态**：地基就绪（单引擎 + 范式原子 + 记忆节点），编排层在路线图上。

## 与 Web 部署的关系

两种服务产出的 workflow 都通过同一条发布路径上线：
export-release → LibreChat 模版站（ADR-008），或 HTTP `/run` 插拔（ADR-012）。
部署层不区分服务 A/B。

## 不属于 PolarUI 的

- 业务集成节点（autooffice / clock / digist / knowlever / polar-design /
  polar-port / polar-process / ssot / taoci / tqsdk）——已归档
  `ClawBin/260710-polarui-two-services-slimdown/`，需要时按新契约重接。
- 渠道接入（飞书 / IDE）——ADR-010 移出。
