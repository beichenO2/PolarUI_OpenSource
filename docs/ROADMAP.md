# PolarUI 路线图

> **SSoT**：[`SSoT.md`](./SSoT.md)

---

## R7 · Workflow HTTP 插拔化（一级能力） ✅

> **契约**：[`WORKFLOW_RUN_CONTRACT.md`](./WORKFLOW_RUN_CONTRACT.md) · [ADR-012](../decisions/012-workflow-http-plugin.md)  
> **定调**：任意语言实现 `POST /run` 即可插入 Web；Python 部署 + HTTP 连接是正式设计约束，不只是 Demo。

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 通用适配器 `http-workflow.mjs` + `/run` 契约 + `http_workflows[]` 三路分发；`_template` / market-truth-cs / Python `mta-python` 验证 | ✅ |
| P2a | **export-release 支持 `http_workflows` 配置直出**（导出时可声明外部服务 URL/id/label/timeout） | ✅ |
| P2b | **画布节点「HTTP Workflow 引用」**（`HttpWorkflow` 节点，GUI + headless 双路径） | ✅ |
| P2c | **契约鉴权**（`auth_token` Bearer + `headers` 自定义头；局域网明文仍为默认 Demo） | ✅ |

> **P2c 服务端校验**：PolarFlow 已实现可选 Bearer 校验（`POLARFLOW_AUTH_TOKEN` 保护 `/run`、`/api/chat`、`/api/runs` 等）。**当前 Web 部署（market-truth-cs）为 Demo 模式，不启用鉴权**；鉴权能力仅作为可选特性保留，供未来独立部署使用。
| P2d | **`GET /v1/models` 返回 label 增强**（附加 `name`/`description`） | ✅ |
| P2e | **history 传递标准化**（Web 壳传对话历史给服务，消除服务进程内内存态） | ✅ |
| ACL | **按用户开 workflow 权限**（[ADR-015](../decisions/015-per-user-workflow-acl.md)：Admin 勾选 + chat 强制校验） | ✅ |
| P3 | **graph-cli 独立进程化**（`lib/run-graph-server.mjs` 常驻 `/run` 服务；graph 工作流可经 `http_workflows[]` 接入，spawn 路径保留兜底） | ✅ |

Skills：[`polarui-workflow-contract`](../skills/polarui-workflow-contract/SKILL.md) · [`polarui-web-deploy`](../skills/polarui-web-deploy/SKILL.md)

---

## R4 · 网站发行版 ✅

| 阶段 | 内容 | 状态 |
|------|------|------|
| W0 | LibreChat fork `_template/` + README 引用 | ✅ |
| W1 | 侧栏 L1情景+L2会话（admin 加 L0用户） | ✅ |
| W2 | 自动命名 + 记忆库 | ✅ |
| W3 | Workflow 代理 + manifest 快照锁定 | ✅ |
| W4 | **分层记忆查看 UI** + 确认队列 | ✅ |
| W5 | 多模态（zip ingest + PDF 出站） | ✅ |
| W6 | `export-release.mjs` 命名递增 | ✅ |
| W7 | `WEB_ACCEPTANCE.md` 全绿 | ✅ |

文档：[`WEB_TEMPLATE.md`](./WEB_TEMPLATE.md) · [`MEMORY.md`](./MEMORY.md) · [`WEB_ACCEPTANCE.md`](./WEB_ACCEPTANCE.md) · [`WEB_EXPORT.md`](./WEB_EXPORT.md)

验收：`npm run test:web-release`

---

## R3 · Workflow 记忆节点 ✅

ScenarioMemoryLoad/Save、SessionMemoryLoad/Save、UserMemoryLoad — 已替换 TaociSessionLoad/Save。

---

## R1 · 测试开发 ✅

---

## R2 · PolarClaw Chat 壳 ❌ cancelled（2026-07-12）

一键上线正式收敛为 R4 export-release（ADR-008）；ADR-006 → superseded。
PolarClaw `/api/workflow/chat` 与 `/api/deployments` 已在 PolarClaw 侧实现，保留为开发调试工具，不进 PolarUI 对外契约（ADR-010 纯粹化）。

---

## R5 · 飞书渠道 ❌ cancelled

渠道接入属部署层，已从 PolarUI 移出（ADR-010）。PolarUI 回归 Workflow 本身；对外保留 LibreChat 模版 Web 一键导出（ADR-008）。

## R6 · 单引擎统一与纯粹化 ✅（进行中收尾见 polaris.json）

见 [ADR-010](../decisions/010-single-engine-and-purity-refactor.md) · [ADR-011](../decisions/011-two-services-and-slimdown.md)。

## 实施顺序

```
已完成：R1 → R3 → R4 → R6（含 P0 QA 门禁）→ R7 全部 → R9 → R10（含真 claude-code 自进化演示）
已关闭：R2（→ R4 export-release）、R5（→ 部署层）
待办：无（R6 P5 截图基线已于 2026-07-12 完成：waypoint 快照进 QA 门，Playwright 截图为独立 test:canvas-baseline）
```
