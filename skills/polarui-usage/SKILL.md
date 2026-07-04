# PolarUI — 使用指南

> 节点图可视化编辑器 + Workflow 引擎：正则化元件、Hub 对接、桌面应用

## Workflow 撰写

新建或修改 workflow 时必读：

- `PolarUI/docs/ARCHITECTURE.md` — 架构原则
- `PolarUI/skills/polarui-workflow-authoring/SKILL.md` — 七步流程

## 核心信息

| 维度 | 值 |
|---|---|
| 健康端点 | 端口 5170（/ (Vite dev server)） |
| 启动命令 | `npm run dev -- --port 5170` |
| 安装命令 | `npm ci` |
| 技术栈 | React, Vite, ReactFlow, Electron (桌面), TypeScript |

## 快速启动

```bash
cd ~/Polarisor/PolarUI
npm ci
npm run dev -- --port 5170
```

## 健康检查

```bash
curl -s http://127.0.0.1:5170/ (Vite dev server)
```

## 依赖服务

- PolarCopilot Hub (API 数据源)
- ReactFlow
