---
name: taoci-outreach-workflow
description: >
  套辞助手 workflow：PolarUI 图即 Harness（所见即所得）。
  阶段 C 实施；撰写前读 polarui-workflow-authoring + docs/ARCHITECTURE.md。
  触发：套辞 workflow、taoci-outreach、导师套辞、@套辞。
---

# 套辞助手 Taoci Outreach

> **Harness = `taoci-outreach.lg.json` 图**（不是 `harness/` 文件夹）  
> **实施阶段**：C 已完成（harness 已删除，测试跑图引擎）

## 必读

| 文档 | 路径 |
|------|------|
| 架构 | `PolarUI/docs/ARCHITECTURE.md` |
| 撰写七步 | `PolarUI/skills/polarui-workflow-authoring/SKILL.md` |
| 规格 | `PolarUI/workflows/taoci-outreach/WORKFLOW.spec.md` |
| 纠偏任务书 | `任务书/260703/套辞workflow.md` |

## 目标图（阶段 C）

```
FeishuIM / PromptInput（入站）
  → WorkingMemory（conversation_id）
  → Switch(session.step)
  → S0: LLM(clarify) | S1: SubAgent×3 | S2: LLM+PDF | S3: LLM+PDF
  → FeishuIM（出站 + PDF）
  → Output
```

无 ReAct、无 ShellExec、无 ToolCall（套辞是状态机，不是终端 Agent）。

## 通道

- Bot：`PolarClaw_Rr`；触发：`@套辞`
- PolarClaw → **graph engine** 执行 `.lg.json`（`taoci-route.ts` → `run-graph-cli.mjs`）

## 实现位置

| 路径 | 说明 |
|------|------|
| `workflows/taoci-outreach/taoci-outreach.lg.json` | WYSIWYG 图 |
| `lib/taoci-graph/` | TaociSessionLoad/Save/SubAgent executor |
| `lib/run-graph-cli.mjs` | PolarClaw 桥接 |

## 测试

`~/Desktop/测试/taoci-outreach/` — L2/L3 必须跑图引擎。
