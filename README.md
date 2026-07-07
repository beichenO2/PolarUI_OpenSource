# PolarUI

ComfyUI 风格 workflow 编辑器与图执行引擎。

## 从这里读

| 文档 | 用途 |
|------|------|
| [`docs/SSoT.md`](./docs/SSoT.md) | **文档入口** |
| [`docs/FRONTEND.md`](./docs/FRONTEND.md) | 前端启动与画布说明 |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 架构 |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | 路线图 |
| [`polaris.json`](./polaris.json) | 功能进度 |

## 一句话

**Workflow 只管数据 IO；网站负责用户与会话。**

## 两阶段

| 阶段 | 入口 |
|------|------|
| 测试开发 | `lib/run-graph-cli.mjs` |
| 部署（网站） | PolarClaw `/api/workflow/chat` |

## 验证

```bash
npm run test:headless
npm run test:gui-overlay
node lib/run-graph-cli.mjs --workflow taoci-outreach --conversation-id test --message "你好"
```
