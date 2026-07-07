# PolarUI 路线图

> **SSoT**：[`SSoT.md`](./SSoT.md)

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

## R5 · 飞书渠道 ⏸

---

## 实施顺序（已完成）

```
1. W0 LibreChat 套壳 + 文档 ✅
2. W1–W2 侧栏 + 记忆库 ✅
3. W3 workflow 代理 ✅
4. W4 分层记忆 UI ✅
5. W5 多模态 ✅
6. W6 发行版脚本 ✅
7. W7 验收全绿 ✅
```
