# PolarUI 路线图

> **SSoT 入口**：[`SSoT.md`](./SSoT.md)  
> **架构**：[`ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## 状态图例

| 标记 | 含义 |
|------|------|
| ✅ | 已完成 |
| 🔄 | 进行中 |
| 📋 | 计划中（近期） |
| ⏸ | 搁置（记入 roadmap，暂不实施） |

---

## R1 · 测试开发阶段 ✅

Workflow 纯数据 IO，图引擎 + benchmark。

| 项 | 状态 | 说明 |
|----|------|------|
| WYSIWYG 架构文档 | ✅ | ADR-001–004、skills |
| Headless graph engine | ✅ | `lib/headless-engine.mjs` + `run-graph-cli.mjs` |
| ToolCall 复合组件 | ✅ | ADR-003 runtime + GUI editor |
| 无 ShellExec | ✅ | 78 workflow 迁移 |
| taoci-outreach 图 | ✅ | Switch + LLM/SubAgent，harness/ 已删 |
| taoci 测试全绿 | ✅ | graph-engine + huyoucai-qa 情景 |
| Claude Code CLI core | 🔄 | `TAOCI_USE_CLAUDE_CLI` 默认开启 |

---

## R2 · 部署阶段（MVP） 🔄

最简路径：复用 PolarClaw 现有基础设施，不新建独立网站。

| 项 | 状态 | 说明 |
|----|------|------|
| GUI executor overlay | ✅ | `gui-overlay` + browser TaociSessionLoad/Save |
| dist/workflows 同步 | ✅ | `sync-workflows.mjs` 纳入 build |
| Deploy preflight | ✅ | `deploy-preflight.mjs` + PolarClaw PUT gate |
| CLI 部署 | ✅ | PolarClaw → `run-graph-cli.mjs`（飞书 IM 在 PolarClaw） |
| Web 部署（Chat 壳） | 📋 | PolarClaw `/api/workflow/chat` + `/chat?workflow=xxx` |
| 画布一键上线 | 📋 | PolarUI GUI → PUT `/api/deployments` → preflight → 注册 |
| 独立模版网站 | ⏸ | `~/Desktop/Web_related/` 预制站 → 见 R4 |

### MVP 部署约定（ADR-006）

- **会话 key**：单层 `conversation_id` → `.sessions/{id}.json`
- **用户隔离**：`user_id` 透传，不强制鉴权（内测信任环境）
- **情景/线程**：不做拆分，后续 R3 解决
- **网站**：先用 PolarClaw Chat 壳，不单独建站

---

## R3 · 记忆拼接 ⏸

> **问题**：部署层会话管理（用户 / 情景 / 对话线程）如何与 workflow 图内记忆（WorkingMemory、SessionLoad/Save）对齐？

### 两个维度的会话隔离（需求已记录，方案未定）

1. **对话线程**：同一情景下，用户换了一个问题（thread）
2. **情景**：用户换了话题，如套辞另一个老师（scenario）

### 待探索方向

| 方向 | 优点 | 风险 |
|------|------|------|
| 部署层管 key，workflow 只管 blob | 职责清晰 | key 结构变更需双端改 |
| workflow 图内显式 Scenario/Thread 节点 | WYSIWYG | 图变复杂，测试夹具难写 |
| 独立 PolarMemory 服务 | 可复用 | 新依赖，过度设计？ |
| session_id = `{user}:{scenario}:{thread}` 拼接 | 最简单扩展 | 情景切换时 thread 清理策略不明 |

**决定**：MVP 不实施。先用单层 `conversation_id`，待有真实用户反馈后再选型。

---

## R4 · 独立网站方案 ⏸

用户原设想：预制模版站 + 用户隔离（用户名直登）+ 双层会话隔离。

| 项 | 状态 | 说明 |
|----|------|------|
| 模版站目录 | ⏸ | `~/Desktop/Web_related/_template/` |
| 每 workflow 独立文件夹 | ⏸ | `~/Desktop/Web_related/{workflow-id}/` |
| 用户名直登 | ⏸ | 无密码，信任环境 |
| 开源 Chat UI 调研 | ✅ | Derin Chat UI、MinimalChat 等（见会话记录） |

**前置条件**：R3 记忆方案确定后，再建独立站。否则 UI 做好了 session 模型还得推翻。

---

## R5 · 基础设施收尾 📋

| 项 | 状态 | 说明 |
|----|------|------|
| WORKFLOW.spec.md 对齐两阶段 | 📋 | taoci spec 仍写飞书为入口，需改 |
| polarui-deploy skill 更新 | 📋 | 补充 CLI/Web 部署路径 |
| FeishuIM 移出 workflow 图 | 📋 | 飞书节点保留给部署专用图，测试图用 PromptInput |
| Claude Code CLI 稳定 | 🔄 | 默认路径验证 + fallback |

---

## 实施顺序（当前）

```
1. 文档整理（本任务）          ← 现在
2. 画布一键上线（R2）           ← 下一步
3. Chat 壳联通验证（R2）
4. R3 记忆方案讨论              ← 有用户反馈后
5. R4 独立网站                  ← R3 之后
```
