# PolarUI 路线图

> **SSoT**：[`SSoT.md`](./SSoT.md)

---

## R7 · Workflow HTTP 插拔化（一级能力） 📋

> **契约**：[`WORKFLOW_RUN_CONTRACT.md`](./WORKFLOW_RUN_CONTRACT.md) · [ADR-012](../decisions/012-workflow-http-plugin.md)  
> **定调**：任意语言实现 `POST /run` 即可插入 Web；Python 部署 + HTTP 连接是正式设计约束，不只是 Demo。

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 通用适配器 `http-workflow.mjs` + `/run` 契约 + `http_workflows[]` 三路分发；`_template` / market-truth-cs / Python `mta-python` 验证 | ✅ |
| P2a | **export-release 支持 `http_workflows` 配置直出**（导出时可声明外部服务 URL/id/label/timeout） | 📋 planned |
| P2b | **画布节点「HTTP Workflow 引用」**（图内直接引用外部 `/run` 服务） | 📋 planned |
| P2c | **契约鉴权**（token / 公网安全；当前仅局域网明文） | 📋 planned |
| P2d | **`GET /v1/models` 返回 label 增强**（HTTP 条目展示名与元数据更完整） | 📋 planned |
| P2e | **history 传递标准化**（Web 壳传对话历史给服务，消除服务进程内内存态） | 📋 planned |

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

## R2 · PolarClaw Chat 壳（过渡） 📋

PolarClaw `/api/workflow/chat` 与画布一键上线仍为 planned；Web 发行版（R4）已独立交付。

---

## R5 · 飞书渠道 ❌ cancelled

渠道接入属部署层，已从 PolarUI 移出（ADR-010）。PolarUI 回归 Workflow 本身；对外保留 LibreChat 模版 Web 一键导出（ADR-008）。

## R6 · 单引擎统一与纯粹化 ✅（进行中收尾见 polaris.json）

见 [ADR-010](../decisions/010-single-engine-and-purity-refactor.md) · [ADR-011](../decisions/011-two-services-and-slimdown.md)。

## 实施顺序

```
已完成：R1 → R3 → R4 → R6 主体 → R7 Phase 1（HTTP 插拔验证）
下一步：R7 P2a–P2e（export 直出 / 画布节点 / 鉴权 / models label / history）
过渡保留：R2 PolarClaw Chat 壳
```
