# PolarUI — 使用指南

> 前端详情：[`docs/FRONTEND.md`](../docs/FRONTEND.md)

## 启动

```bash
cd ~/Polarisor/PolarUI
npm ci
npm run dev -- --port 5170
```

打开 http://127.0.0.1:5170/ — **无需切换 LG/WF 模式**（Tab 已删），从 Workflow 面板或打开 JSON 加载图即可。

## Workflow 撰写与部署

| 阶段 | Skill / 文档 |
|------|-------------|
| 画布编辑 | [`polarui-workflow-authoring`](../skills/polarui-workflow-authoring/SKILL.md) |
| Web 运行时契约 | [`polarui-workflow-contract`](../skills/polarui-workflow-contract/SKILL.md) |
| 部署到 Web | [`polarui-web-deploy`](../skills/polarui-web-deploy/SKILL.md) |
| 架构 | [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) |

## 依赖服务（可选）

| 服务 | 端口 | 用途 |
|------|------|------|
| PolarProcess | 11055 | 生态服务列表（dev 经 vite proxy） |
| PolarCopilot Hub | 8040 | SSoT 在线编辑（dev 可回退本地 polaris.json） |
| PolarPrivate | 12790 | LLM |

## 健康检查

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5170/
curl -s http://127.0.0.1:5170/api/polaris/PolarUI | head -c 80
```
