# ADR-011 双服务定位与彻底瘦身

- 状态：accepted
- 日期：2026-07-10
- 进度追踪：`polaris.json` **R8**（R7 已被 ADR-012 HTTP 插拔并发占用）
- 前置：ADR-010（单引擎统一）、ADR-002（Harness 即图）、ADR-007（记忆三层）、ADR-008（Web 发行版）

## 背景

ADR-010 完成了单引擎统一，但保留了兼容层（`.lg.json` 后缀回退读取、`library` 字段容忍）。
同时注册的 workflow 与组件（node-defs 约 215 个节点、17 个文件）绝大多数是业务集成节点，
基本不可用、无测试覆盖，掩盖了 PolarUI 的真正核心能力。

用户决策（2026-07-10）：

1. 不保留旧实现——兼容层删除，单一执行模型是唯一路径。
2. 除 ClaudeCode 复现 workflow 外，注册 workflow 全部删除（归档）。
3. PolarUI 重新定位为**两种服务**。

## 决策

### D1 双服务定位

| 服务 | 定位 | 原子 | 参考实现 |
|------|------|------|----------|
| **A · Agent 搭建**（ClaudeCode 类） | 从 LLM + 正则化/结构化抽取 开始搭建 Agent 体系 | core 原子节点（LLM、RegexMatch、SchemaExtract、ToolCall、ContextWindow、RetryLoop、Switch…） | `workflows/claude-code/` |
| **B · Agentic Workflow 搭建**（Dify 类自进化） | 以 ClaudeCode 型 Agent 为原子 + Harness（图本身，ADR-002）编排工作流 | SubAgent / AgenticUnit / Planner 等范式节点 + 记忆节点 | 待建（以 A 为地基） |

自进化能力属于服务 B 的路线图；旧自进化实现已按 ADR-010 P4 归档，
**不复活旧实现**，未来基于 `docs/specs/evolution/` 设计稿在新地基上重建。

### D2 单执行模型无兼容层

- 删除 `.lg.json` 后缀的回退读取逻辑（loader / lib / 脚本 / 测试全链路）。
- 删除代码中残留的 `library === 'LG'` 判断与 `LG` 命名概念（`_entry`/`_lg_edges`
  作为**图元数据 schema 字段名**保留，它是图特性不是第二引擎）。
- 双份 Agent 图（同名 `.json` 与 `.lg.json`）去重，只保留新图。

### D3 Workflow 清零 + claude-code 升格

- `workflows/taoci-outreach/`、`workflows/market-truth-cs/` 及 `dist/workflows/`
  全部陈旧副本 → ClawBin 归档（P13 六维检查后执行）。
- ClaudeCode 复现图从 dist 快照恢复为源码：`workflows/claude-code/claude-code.json`
  （`.json` 后缀），移除对已归档节点（StemCell、LG_EvolutionGuard）的引用，
  headless 跑通并纳入 QA。
- QA 中依赖 taoci/market-truth 的测试改为 claude-code + 合成 fixtures。

### D4 node-defs 瘦身

| 保留 | 理由 |
|------|------|
| `core.json`（29） | 服务 A 原子 |
| `tools-system.json`（18） | Agent 工具面（ADR-004 约束仍适用） |
| `polar-memory.json`（6） | 服务 B 记忆能力（ADR-007，R3 交付） |
| `paradigms.json`（新，≈6） | 服务 B 范式原子：AgentWorkflow、AgenticUnit、AgenticChain、Planner、WorkflowMeta、SelfHealUnit |
| `annotation.json`（1） | 画布批注 |

归档：autooffice、clock、digist、knowlever、polar-design、polar-port、polar-process、
ssot、taoci、tqsdk、tools-misc、registry-paradigms 中的业务管线节点
（PolarDesignPipeline、Checkup*、TQ*、KnowLever* 等）。
对应 `lib/` 集成执行器与 `src` executor 分支一并归档/删除，`sync-node-defs` 与
`index.json` 同步更新。

## 后果

- 正面：核心能力（图引擎 + 画布 + claude-code 参考实现 + Web 导出）暴露清晰；
  QA 覆盖率相对面积大幅上升；新服务 B 有干净地基。
- 负面：业务集成（taoci、digist、autooffice 等）短期不可从 PolarUI 编排，
  需要时从 ClawBin 恢复并按新契约重写。
- 回滚点：ClawBin `260710-polarui-two-services-slimdown/`。

## 执行阶段（QA 门禁逐阶段全绿）

- P1 引擎去兼容层（D2）
- P2 claude-code 升格 + workflow 清零 + QA 重接（D3）
- P3 node-defs / lib 瘦身（D4）
- P4 文档与 SSoT 定位重写（D1）
