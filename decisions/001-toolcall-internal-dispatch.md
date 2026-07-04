# ADR-001（旧）：ToolCall 内部分发（无 tool 别名）

**日期**：2026-07-04  
**状态**：**deprecated**  
**取代者**：ADR-001 `001-wysiwyg-principle.md`、ADR-003 `003-toolcall-composite-component.md`

## 为何废弃

本 ADR 主张 ToolCall executor 内建 dispatch（`lib/tool-dispatch.mjs`、`W5t()` patch），在 executor 内部执行 FileRead/WebSearch/ShellExec，**图上不可见**，违反所见即所得。

同时错误保留 ShellExec 为 palette_hidden 内部工具。

## 处置

- 文档：已从 skills / polaris.json 移除引用
- 代码：`lib/tool-dispatch.mjs`、bundle patch — **基础设施阶段删除**（见 `docs/ARCHITECTURE.md` 阶段 B）

## 历史记录（勿遵循）

~~ToolCall executor 内建 dispatch~~  
~~ShellExec palette_hidden，仅 ToolCall 内部分发~~  
~~禁止 Switch 并列工具节点~~
