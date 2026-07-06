# PolarUI

ComfyUI 风格 workflow 编辑器与图执行引擎。

## 从这里读

| 文档 | 用途 |
|------|------|
| [`docs/SSoT.md`](./docs/SSoT.md) | **文档入口** |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 架构：测试开发 vs 部署 |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | 路线图 |
| [`polaris.json`](./polaris.json) | 功能进度 |
| [`decisions/`](./decisions/) | ADR |

## 一句话

**Workflow 只管数据 IO；渠道、用户、会话在部署层（PolarClaw）。**

## 两阶段

| 阶段 | 做什么 | 入口 |
|------|--------|------|
| 测试开发 | 输入 JSON → graph → 输出 JSON | `lib/run-graph-cli.mjs` |
| 部署 | CLI / Web 上线 | PolarClaw `run-graph-cli` 或 `/api/workflow/chat` |

## 验证

```bash
npm run test:headless
npm run test:gui-overlay
npm run test:preflight
node lib/run-graph-cli.mjs --workflow taoci-outreach --conversation-id test --message "你好"
```

## 目录

- `docs/` — SSoT、架构、路线图
- `decisions/` — ADR
- `lib/` — headless engine、executor、preflight
- `workflows/` — 图源
- `dist/` — build 产物
- `skills/` — Agent 操作指南
