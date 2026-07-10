---
name: taoci-outreach-workflow
description: >
  套辞助手 workflow：PolarUI 图即 Harness（所见即所得）。
  阶段 C 实施；撰写前读 polarui-workflow-authoring + docs/ARCHITECTURE.md。
  触发：套辞 workflow、taoci-outreach、导师套辞、@套辞。
---

# 套辞助手 Taoci Outreach

> **Harness = `taoci-outreach.lg.json` 图**（不是 `harness/` 文件夹）  
> **实施阶段**：C 已完成；R3 记忆节点 + R4 Web 发行版已交付

## 必读

| 文档 | 路径 |
|------|------|
| 架构 | `PolarUI/docs/ARCHITECTURE.md` |
| 撰写七步 | `PolarUI/skills/polarui-workflow-authoring/SKILL.md` |
| Web 契约 | `PolarUI/skills/polarui-workflow-contract/SKILL.md` |
| Web 部署 | `PolarUI/skills/polarui-web-deploy/SKILL.md` |
| 规格 | `PolarUI/workflows/taoci-outreach/WORKFLOW.spec.md` |

## 目标图（当前）

```
PromptInput（入站）
  → WorkingMemory（conversation_id）
  → UserMemoryLoad
  → ScenarioMemoryLoad
  → Switch(session.step)
  → S0: LLM(clarify) | S1: SubAgent×3 | S2: LLM+PDF | S3: LLM+PDF
  → ScenarioMemorySave（各分支）
  → Output
```

无 ReAct、无 ShellExec、无 ToolCall、**无 FeishuIM**（R5 搁置）。

## 通道

- **Web 发行版**：`~/Desktop/Web_related/{release_id}/`（`export-release.mjs`）
- **PolarClaw**（R2 过渡）：`run-graph-cli.mjs` + `--memory-json`

## 实现位置

| 路径 | 说明 |
|------|------|
| `workflows/taoci-outreach/taoci-outreach.lg.json` | WYSIWYG 图 |
| `lib/memory-graph/` | User/Scenario/Session 记忆 executor |
| `lib/taoci-graph/` | TaociSubAgent executor |
| `lib/run-graph-cli.mjs` | PolarClaw / 发行版桥接 |
| `scripts/export-release.mjs` | Web 发行版编译导出 |

## 测试

- `npm run test:web-release` — 发行版 + 记忆节点全绿
- `node --test workflows/taoci-outreach/tests/run.mjs` — 图引擎
