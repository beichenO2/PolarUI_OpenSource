# PolarUI — 故障排查

> 节点图可视化编辑器 + Workflow 引擎：正则化元件、Hub 对接、桌面应用

## 健康检查

```bash
# 进程存活
pgrep -f "PolarUI" || echo "NOT RUNNING"

# HTTP 端点
curl -s http://127.0.0.1:5170/ (Vite dev server)
```

## 关键端口

| 端口 | 说明 |
|---|---|
| 5170 | PolarUI 主服务 |

## 常见故障

### 1. 节点渲染异常

**修复**：`清除浏览器缓存，检查 ReactFlow 版本`

### 2. Hub API 对接失败

**修复**：`确认 Hub 在 8040 端口运行`

### 3. 桌面打包失败

**修复**：`检查 Electron 和 electron-builder 版本`

## 依赖服务

- PolarCopilot Hub (API 数据源)
- ReactFlow

## 紧急恢复

```bash
cd ~/Polarisor/PolarUI
npm run dev -- --port 5170
curl -s http://127.0.0.1:5170/ (Vite dev server) && echo 'OK' || echo 'BROKEN'
```
