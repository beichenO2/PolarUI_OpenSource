# PolarUI

ComfyUI 风格 workflow 编辑器与图执行引擎。**Harness = `.lg.json` 图本身。**

## 核心原则（必读）

[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

1. **所见即所得** — 明面组件 = 全部逻辑  
2. **Harness = 图** — 不是 `harness/` 文件夹  
3. **没有 ShellExec**  
4. **ToolCall = 复合组件**（对齐 PolarClaw tool list + 加载工具）

## 实施顺序

| 阶段 | 内容 | 状态 |
|------|------|------|
| A 文档 | ADR、skills、polaris.json | ✅ |
| B 基础设施 | graph engine、ToolCall 骨架、移除错误 dispatch | 🔄 进行中 |
| C workflow | taoci 图重写（无 ShellExec） | 🔄 进行中 |

## SSoT

| 文档 | 用途 |
|------|------|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 架构总览 |
| [`polaris.json`](./polaris.json) | 功能进度 |
| [`decisions/`](./decisions/) | ADR |
| [`skills/`](./skills/) | Agent 操作指南 |

## ADR 索引

- [001 所见即所得](./decisions/001-wysiwyg-principle.md)
- [002 Harness 即图](./decisions/002-harness-is-the-graph.md)
- [003 ToolCall 复合组件](./decisions/003-toolcall-composite-component.md)
- [004 没有 ShellExec](./decisions/004-no-shellexec.md)

## 目录

- `docs/` — 架构文档
- `dist/` — 运行时（Vite build）
- `lib/` — 可复用模块（feishu-im 等）
- `workflows/` — workflow 源码
- `dist/node-defs/` — 节点定义

## 验证

```bash
npm run test:toolcall-composite
npm run patch:lg-runner
npm run validate:workflows   # ADR-004 门禁：无 ShellExec   # vite build 后需重打（LG 图走 S4t 非 WF topological）
node lib/run-graph-cli.mjs --workflow taoci-outreach --conversation-id id --message "..."
```
