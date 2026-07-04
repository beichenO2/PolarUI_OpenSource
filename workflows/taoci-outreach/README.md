# 套辞助手 · taoci-outreach

> **Harness = `taoci-outreach.lg.json` 图**（见 `WORKFLOW.spec.md`、`../../docs/ARCHITECTURE.md`）

## 架构

| 组件 | 实现 |
|------|------|
| Harness | `.lg.json` WYSIWYG 状态机 |
| PolarClaw | `run-graph-cli.mjs` → executeGraph |
| 图 | WorkingMemory → Switch(step) → LLM/SubAgent → FeishuIM → Output |

## 实现

| 路径 | 说明 |
|------|------|
| `taoci-outreach.lg.json` | WYSIWYG 状态机图 |
| `lib/taoci-graph/` | SessionLoad/Save/SubAgent executor |
| `tests/` | 图引擎 + 多轮情景测试 |

## 文档

- 规格：`WORKFLOW.spec.md`
- Skill：`../../skills/taoci-outreach/SKILL.md`
- 任务书：`~/Polarisor/任务书/260703/套辞workflow.md`

## 测试

```bash
cd PolarUI/workflows/taoci-outreach
node tests/run.mjs
```

Session: `.sessions/`
