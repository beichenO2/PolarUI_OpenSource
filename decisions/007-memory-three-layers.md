# ADR-007：记忆三层 — 网站 SSoT + Workflow 增量

**日期**：2026-07-07  
**状态**：accepted

## 背景

部署阶段每个 workflow 对应独立网站。记忆必须由网站管理（用户登录、站间隔离），workflow 只管计算与业务状态迁移。

用户要求三层：用户 - 主题/情景 - 会话；且用户层/主题层可查看、LLM 提议、人确认。

## 决策

### 1. 网站是记忆 SSoT

- 存储：`~/Desktop/Web_related/{site}/data/app.db`（SQLite）
- 三层：user / topic(scenario) / session
- Admin 可看所有用户

### 2. Workflow 三个独立记忆模块

| 模块 | Load | Save |
|------|------|------|
| UserMemory | ✅ 读快照 | ❌ 不写 |
| ScenarioMemory | ✅ | ✅ delta |
| SessionMemory | ✅ | ✅ delta |

### 3. 通信契约

- 入：`memory: { user, scenario, session }` + message
- 出：`reply` + `memory_delta: { scenario?, session? }`

### 4. 用户/主题层确认流程

- 每轮对话后，**网站侧** LLM 总结记忆变更
- 每条变更弹窗，用户确认后写入 DB
- Workflow 写的 scenario 增量自动合并；超出 schema 的也走确认

## 关联

- `docs/MEMORY.md`
- `docs/WEB_TEMPLATE.md`
