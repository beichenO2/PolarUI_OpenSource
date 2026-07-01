# 套辞助手 · 本地 Workflow 部署

## 组件

| 组件 | 路径 | 作用 |
|------|------|------|
| 状态机 Harness | `harness/index.mjs` | Step0–3 循环、session 持久化 |
| Claude Core | `harness/lib/claude-core.mjs` | claude CLI → PolarPrivate |
| SubAgents | `harness/subagents/` | 风评 / 署名 / 方向 |
| PDF | `harness/lib/pdf.mjs` | xelatex 编译 |
| PolarUI 图 | `taoci-outreach.lg.json` | 飞书 → ShellExec → harness |
| 飞书桥 | `feishu/bridge.mjs` | PolarClaw 调用入口 |

## 依赖

```bash
curl -s http://127.0.0.1:12790/v1/models | head
xelatex --version
claude --version  # 可选
```

## 本地测试

```bash
cd ~/Polarisor/PolarUI

node workflows/taoci-outreach/harness/index.mjs \
  --conversation-id demo-1 \
  --message "想套辞北京协和医学院胡友财老师，中国药科大学制药工程2023级"
```

Session: `workflows/taoci-outreach/.sessions/`

## 飞书

见 `WORKFLOW.spec.md` 部署清单。
