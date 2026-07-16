# PolarUI

ComfyUI 风格 workflow 编辑器与图执行引擎。

## 双服务定位（ADR-011）

PolarUI 对外只提供两种服务，全部节点/workflow/文档/测试都必须能归属其一（详见 [`docs/SERVICES.md`](./docs/SERVICES.md)）：

| 服务 | 一句话 | 原子 | 参考实现 |
|------|--------|------|----------|
| **A · Agent 搭建**（ClaudeCode 类） | 从 LLM + 结构化抽取原子逐步搭出完整 Agent | `node-defs/core.json` + `tools-system.json` | [`workflows/claude-code/`](./workflows/claude-code/)（唯一注册 workflow，QA e2e 黄金样例） |
| **B · Agentic Workflow 搭建**（Dify 类自进化） | 以 ClaudeCode 型 Agent 为原子 + Harness（图本身，ADR-002）编排自进化系统 | `node-defs/paradigms.json` + `polar-memory.json` + `evolve.json` | 自进化内核 StemCell / PetriDish（ADR-014） |

不属于 A/B 的（业务集成节点、飞书/IDE 渠道）已移出 PolarUI。

## 运行时治理

稳定 GUI 使用 service ID `polarui` 与 preferred port 5170。PolarPort 是唯一端口权威，PolarProcess 是唯一生命周期权威：

```bash
curl -fsS http://127.0.0.1:11055/api/services/polarui
curl -fsS -X POST http://127.0.0.1:11055/api/services/polarui/restart
```

Native Web preview、QA/brainstorm 服务和导出的 Web release 都是独立边界，不得作为 `polarui` 的别名操作。禁止直接启动持久 Vite/Node/Docker 进程、后台任务、PID 文件、直接信号或 launchd。

## 导航

两大领域分开读——**工作流**（画布设计）与 **Web 部署**（发行版运维）职责不同、文档不同。

### 🔷 工作流（画布编辑 · 图引擎 · 节点）

在 PolarUI 里设计、测试 workflow 图（`.json`，单一执行模型 ADR-010），与网站用户/会话无关。

| 入口 | 一句话 |
|------|--------|
| [`skills/polarui-workflow-authoring/SKILL.md`](./skills/polarui-workflow-authoring/SKILL.md) | 七步撰写：spec → 节点 → workflow `.json` → mock 测试 |
| [`skills/polarui-workflow-contract/SKILL.md`](./skills/polarui-workflow-contract/SKILL.md) | **Web 需要什么 workflow**：builtin / **HTTP `/run`** / memory_delta |
| [`workflows/`](./workflows/) | workflow 源码目录 |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 两阶段隔离、WYSIWYG 原则 |
| [`docs/WORKFLOW_RUN_CONTRACT.md`](./docs/WORKFLOW_RUN_CONTRACT.md) | **一级约束**：任意语言实现 `/run` 即可插进 Web |
| [`lib/run-graph-cli.mjs`](./lib/run-graph-cli.mjs) | 测试开发阶段 headless 跑图 |

### 🔶 Web 部署（模版 · export · 发行版运维）

把 workflow **编译**成独立 LibreChat 站点（`~/Desktop/Web_related/`）。

| 入口 | 一句话 |
|------|--------|
| [`skills/polarui-web-deploy/SKILL.md`](./skills/polarui-web-deploy/SKILL.md) | **怎么部署**：export-release → builtin **或 HTTP `/run`** → Docker → 验收 |
| [`docs/WEB_EXPORT.md`](./docs/WEB_EXPORT.md) | 导出流水线 12 步详规 |
| [`docs/DEPLOYMENT_SPEC.md`](./docs/DEPLOYMENT_SPEC.md) | **三层部署正交铁律**（WorkFlow / Web Demo / 独立 Web） |
| [`docs/WEB_TEMPLATE.md`](./docs/WEB_TEMPLATE.md) | 发行版命名、LibreChat 套壳规格 |
| [`docs/MEMORY.md`](./docs/MEMORY.md) | 三层记忆 SSoT（网站存、workflow 写 delta） |
| [`docs/WEB_ACCEPTANCE.md`](./docs/WEB_ACCEPTANCE.md) | TDD 自动化门禁 |
| 模版 `_template/` | `~/Desktop/Web_related/_template/docs/WORKFLOW_INTEGRATION.md` |
| 参考实例 | `~/Desktop/Web_related/market-truth-cs/`（含 HTTP 插拔验证） |

### 通用

| 文档 | 用途 |
|------|------|
| [`docs/SSoT.md`](./docs/SSoT.md) | **文档总入口** |
| [`docs/FRONTEND.md`](./docs/FRONTEND.md) | 前端启动与画布说明 |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | 路线图 |
| [`polaris.json`](./polaris.json) | 功能进度 |
| [`skills/polarui-usage/SKILL.md`](./skills/polarui-usage/SKILL.md) | 启动 GUI（`:5170`） |
| [`skills/polarui-deploy/SKILL.md`](./skills/polarui-deploy/SKILL.md) | 部署索引（本地 vs Web） |

## 一句话

**Workflow 只管数据 IO；网站负责用户与会话。**

## 两阶段

| 阶段 | 入口 |
|------|------|
| 测试开发 | `lib/run-graph-cli.mjs` |
| 部署（网站） | [`skills/polarui-web-deploy`](./skills/polarui-web-deploy/SKILL.md) · LibreChat 模版一键导出（ADR-008） |

## 验证

```bash
npm run build
npm run qa
node lib/run-graph-cli.mjs --workflow claude-code --conversation-id test --message "你好"
```
