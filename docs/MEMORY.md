# 记忆模块设计

> **网站规格**：[`WEB_TEMPLATE.md`](./WEB_TEMPLATE.md)  
> **验收标准**：[`WEB_ACCEPTANCE.md`](./WEB_ACCEPTANCE.md)

---

## 1. 核心原则

| 原则 | 说明 |
|------|------|
| **网站是 SSoT** | 记忆权威存储在发行版独立库 |
| **Workflow 是计算层** | 读 snapshot、写 delta，不直连网站 DB |
| **查看必须分层** | 用户 / 情景 / 会话 三个独立视图，禁止混在一个 Tab |
| **LLM 提议、人确认** | 用户层 + 情景层变更需确认后落库 |

### 命名对照

| 网站 UI | Workflow 节点 | JSON 层 key | **scope_key（存储命名空间，append 防串味）** |
|---------|--------------|-------------|---------------------------------------------|
| 用户记忆 | UserMemoryLoad（只读） | `user` | `{user_id}` |
| 情景（任务） | ScenarioMemoryLoad/Save | `scenario` | `{user_id}-{scenario_id}` |
| 会话 | SessionMemoryLoad/Save | `session` | `{user_id}-{scenario_id}-{session_id}` |

Workflow `--memory-json` 仍用三层对象 `{ user, scenario, session }`；网站 DB 每条 `memory_entries` 带 `scope_key`，查询时 **必须** 匹配完整 append 链，禁止仅用 `layer` 或裸 `owner_id` 跨用户读取。

---

## 2. 三层数据模型

（数据结构与前一版相同，略）

### 2.1 UserMemory

跨情景长期画像。`site.config.json` 定义 `user_memory_schema.required`。

### 2.2 ScenarioMemory

一个情景（任务）内的业务状态。`scenario_memory_schema` 由 workflow 导出时写入 manifest。

### 2.3 SessionMemory

当前会话 turns + working 状态。自动追加，不需逐条确认。

---

## 3. 记忆查看 UI（分层设计）

> 「我的记忆」不是一页糊在一起，而是 **三层各有一套查看入口与布局**。

### 3.1 入口结构

顶栏 `[用户头像]` 下拉：

```
├─ 用户记忆          → /memory/user
├─ 情景记忆          → /memory/scenario        （需先选情景，或从当前情景进入）
├─ 会话记录          → /memory/session         （需先选会话，或从当前会话进入）
└─ （admin）用户管理  → /admin/users
```

侧边栏右键情景/会话项 → 「查看此层记忆」快捷跳转。

### 3.2 用户记忆页 `/memory/user`

**绑定对象**：当前登录 `user_id`（admin 查看他人时 URL 带 `?user=xxx`）

**布局**：

```
┌─ 用户记忆 ─────────────────────────────────────────┐
│ 必填完成度  ████████░░  6/8                          │
├────────────────────────────────────────────────────┤
│ [画像 Profile] [偏好 Preferences] [能力 Skills]     │  ← 分组 Tab
├────────────────────────────────────────────────────┤
│  school        中国药科大学     ✓必填  2026-07-01   [编辑][删] │
│  major         制药工程         ✓必填  2026-07-01   [编辑][删] │
│  grade         大三             可选   2026-07-05   [编辑][删] │
│  writing_style （未填写）        ✓必填  —            [补填]      │
├────────────────────────────────────────────────────┤
│  + 手动添加记忆条目                                   │
└────────────────────────────────────────────────────┘
```

| 元素 | 规则 |
|------|------|
| 必填标记 | schema `required` 字段红色「必填」徽章；未填显示「（未填写）」 |
| 来源徽章 | `用户确认` / `LLM 提议` / `手动` 三色 |
| 编辑 | 行内编辑 value；改 key 需确认（防误删关联） |
| 删除 | 二次确认；必填项删除后完成度下降 |

### 3.3 情景记忆页 `/memory/scenario/:scenarioId`

**绑定对象**：一个情景（任务）

**布局**：

```
┌─ 情景记忆：套辞胡友财老师 ────────────────────────────┐
│  step: S2_Select    创建于 2026-07-06                 │
├────────────────────────────────────────────────────┤
│ [业务状态] [调研结果] [产物 Artifacts]               │  ← 按 schema 分组
├────────────────────────────────────────────────────┤
│  teacher.name          胡友财        workflow  07-06  │
│  teacher.institution   中国药科大学   LLM确认   07-06  │
│  step                  S2_Select     workflow  07-07  │
│  research.reputation   {…}           workflow  07-07  │
│  selected_direction    （未填写）     必填      —      │
├────────────────────────────────────────────────────┤
│  关联会话：3 个  [查看会话列表]                        │
└────────────────────────────────────────────────────┘
```

| 元素 | 规则 |
|------|------|
| 分组 | 按 `scenario_memory_schema` 的 logical groups 渲染 |
| workflow 写入 | 来源标「workflow」，**自动合并**，不弹确认 |
| LLM 提议写入 | 来源标「待确认」→ 跳确认队列 |
| 只读字段 | `step` 等可由 workflow 覆盖的字段：用户可编辑但下次对话可能被覆盖（提示） |

### 3.4 会话记忆页 `/memory/session/:sessionId`

**绑定对象**：一个会话

**布局**：

```
┌─ 会话记录：话术修改讨论 ──────────────────────────────┐
│  所属情景：套辞胡友财老师    共 12 轮                 │
├────────────────────────────────────────────────────┤
│ [时间线] [关键点] [原始轮次]                         │
├────────────────────────────────────────────────────┤
│  时间线（默认）：                                      │
│   07-07 10:00  用户询问导师风评                       │
│   07-07 10:02  助手返回调研摘要                       │
│   07-07 10:15  用户选定方向二                         │
├────────────────────────────────────────────────────┤
│  关键点（LLM 提取，可编辑删除）：                       │
│   • 倾向方向二：纳米制剂                             │
│   • 待确认：是否需要英文版话术                         │
├────────────────────────────────────────────────────┤
│  原始轮次（折叠）： [展开 12 条消息]                    │
└────────────────────────────────────────────────────┘
```

| 元素 | 规则 |
|------|------|
| 时间线 | LLM 对 turns 的摘要，非完整气泡 |
| 关键点 | session 层可编辑记忆（optional） |
| 原始轮次 | 只读折叠，点击跳转到聊天区对应位置 |
| 删除 | 只能删「关键点」，不能删原始轮次（保留审计） |

### 3.5 Admin 记忆查看

Admin 通过 **L0 用户栏** 选人后，三层入口同上，URL 带 `?user=`：

```
/admin/memory/user?user=guoyunyi
/admin/memory/scenario?user=guoyunyi&scenario=xxx
/admin/memory/session?user=guoyunyi&session=yyy
```

Admin 默认**只读**；编辑需显式「干预模式」开关（roadmap）。

### 3.6 确认队列（跨层）

每轮对话后的待确认项统一入口：

```
顶栏徽章 「记忆 2」→ 侧滑面板
├─ [用户层] major → 制药工程（研一）  [采纳][编辑][忽略]
└─ [情景层] teacher.url → https://...  [采纳][编辑][忽略]
```

---

## 4. 自动命名（从零对话）

用户不选情景、直接发首条消息时：

```
1. 创建 draft 情景 + draft 会话（临时 UUID）
2. 调 workflow 处理消息
3. 调 LLM TitleWriter：
   - scenario_title ← 从首条消息提炼任务名（如「套辞胡友财老师」）
   - session_title  ← 从首条消息提炼会话名（如「初次咨询」）
4. 写入侧栏 L1/L2，替换「新对话」占位
```

**触发时机**：首条 assistant 回复完成后（有足够上下文）。

---

## 5. 网站 ↔ Workflow 通信

（契约同前，略）

**规则**：
- Workflow **不写** `user` 层
- Workflow **可写** `scenario` + `session` delta
- 网站合并 delta 后触发 MemoryWriter → 确认队列

---

## 6. Admin 侧边栏（修正）

```
Admin 登录后的侧栏 = 3 列（L0 + L1 + L2），不是「主题栏第一级 = 用户」

L0 用户栏：guoyunyi | zhangsan | lisi | ...
    ↓ 选中 guoyunyi
L1 情景栏：套辞胡友财 | 套辞李老师 | ...
    ↓ 选中 套辞胡友财
L2 会话栏：初次咨询 | 话术修改 | ...
```

普通用户无 L0，仅 L1 + L2。

---

## 7. Workflow 图内记忆模块

（节点清单同 ADR-007，略）

---

## 8. 数据库

（表结构同前，增加字段）

```sql
ALTER TABLE topics ADD COLUMN auto_title INTEGER DEFAULT 1;
ALTER TABLE sessions ADD COLUMN auto_title INTEGER DEFAULT 1;
ALTER TABLE memory_entries ADD COLUMN status TEXT DEFAULT 'active';  -- active | pending | rejected
```

`status=pending`：待用户确认的 LLM 提议。
