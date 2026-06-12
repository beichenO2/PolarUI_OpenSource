# PolarUI — 部署指南

> 节点图可视化编辑器 + Workflow 引擎：正则化元件、Hub 对接、桌面应用

## 环境要求

- 技术栈：React, Vite, ReactFlow, Electron (桌面), TypeScript
- 安装：`npm ci`

## 安装步骤

```bash
cd ~/Polarisor/PolarUI
npm ci
```

## 启动方式

```bash
cd ~/Polarisor/PolarUI
npm run dev -- --port 5170
```

## 端口分配

| 端口 | 用途 |
|---|---|
| 5170 | 主服务 |

## 健康检查确认

```bash
curl -s http://127.0.0.1:5170/ (Vite dev server)
```

## 回滚方式

```bash
cd ~/Polarisor/PolarUI
git log --oneline -5
git checkout <previous-commit>
npm ci
npm run dev -- --port 5170
```
