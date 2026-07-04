# ADR-004：PolarUI workflow 没有 ShellExec

**日期**：2026-07-04  
**状态**：accepted

## 背景

曾存在 ShellExec 节点（含 `palette_hidden` 供 ToolCall 内调、或图上并列、或 `harness/index.mjs` 黑盒）。用户明确：**没有 ShellExec** — 不是隐藏，是不作为 PolarUI workflow 的能力原语。

## 决策

1. **workflow 范式不含 ShellExec** — 新图不得出现 ShellExec 节点；tool list 不得注册 ShellExec。
2. **禁止 shell 外包** — 不得用任意 shell 命令节点/runner 代替缺失的图节点能力。
3. **legacy 处置**（基础设施阶段）：
   - `dist/node-defs/tools-system.json` 中 ShellExec 标记 deprecated 或从 workflow 索引移除
   - 现有含 ShellExec 的 `.lg.json` 迁移或标注 legacy
   - taoci `harness/index.mjs` 删除，逻辑上浮到图

## 后果

- 缺能力 → 补 **明面节点**（LLM、SubAgent、FeishuIM、FileRead…），不是 shell
- 文档 / skills 不得再写「ShellExec palette_hidden」

## 关联

- ADR-001 WYSIWYG
- ADR-002 Harness 即图
