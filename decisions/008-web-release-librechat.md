# ADR-008：Web 发行版模型 + LibreChat 套壳

**日期**：2026-07-07（修订）  
**状态**：accepted

## 背景

（前文略）

5. 导出需双入口：PolarUI Web + CLI（Agent 调用）。
6. 网站**必须由脚本编译** workflow 内容生成，禁止 Agent 手写网站。

## 决策

### 1. 发行版（Release）

（同前：命名递增、并存）

### 2. 双入口、单脚本

- `scripts/export-release.mjs` 为唯一实现
- PolarUI Web「导出网站」→ spawn / API 调同一脚本
- CLI：`node scripts/export-release.mjs --workflow {id}`

### 3. 脚本编译，禁止手写

- 流水线 Step 0–10：从 workflow 逐一编译 graph / schema / prompts / config
- Agent **只调 CLI**，不在 `Web_related/` 写业务代码
- 改 UI 基底 → 改 `_template/polar/` + 重 export

### 4. UI 基底

（LibreChat fork，同前）

### 5. 侧栏 / 多模态

（同前）

## 关联

- `docs/WEB_EXPORT.md`
- `docs/WEB_TEMPLATE.md`
- `docs/WEB_ACCEPTANCE.md`
- `decisions/009-polar-jwt-auth-chain.md`
