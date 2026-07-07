# PolarUI 网站模版规格

> **SSoT**：[`SSoT.md`](./SSoT.md) · **记忆**：[`MEMORY.md`](./MEMORY.md) · **验收**：[`WEB_ACCEPTANCE.md`](./WEB_ACCEPTANCE.md)  
> **工作目录**：`~/Desktop/Web_related/`  
> **UI 基底**：[LibreChat](https://github.com/danny-avila/LibreChat)（MIT，套壳改造）

---

## 1. 定位

**Web = Workflow 的发行版（Release）**，由**脚本编译**生成，非 Agent 手写。

| 概念 | 说明 |
|------|------|
| Workflow | PolarUI 图源 + 图引擎，持续迭代 |
| Web 发行版 | `export-release.mjs` 从 workflow **逐步编译**出的独立应用 |
| 导出入口 | **PolarUI Web 按钮** + **CLI**（同一脚本） |
| 关系 | 快速部署；**无义务**随 workflow 更新而同步 |

更新 workflow 后若需新站 → 重新 export → 新文件夹 `原名_1`（见 §2、[`WEB_EXPORT.md`](./WEB_EXPORT.md)）。

---

## 2. 目录与发行版命名

```
~/Desktop/Web_related/
├── _template/                    # LibreChat 套壳模版（含 POLAR 改造层）
├── taoci-outreach/               # 首发发行版（workflow 快照 A）
├── taoci-outreach_1/             # 第二次导出（快照 B），与上并存
├── taoci-outreach_1_1/           # 第三次导出（快照 C）
└── {workflow_id}_{suffix}/       # suffix 规则见下
```

### 命名规则

| 操作 | 新文件夹名 |
|------|-----------|
| 首次导出 `taoci-outreach` | `taoci-outreach` |
| 同 workflow 再导出 | `taoci-outreach_1` |
| 从 `_1` 再导出 | `taoci-outreach_1_1` |
| 从 `_1_1` 再导出 | `taoci-outreach_1_1_1` |

**规则**：在**当前发行版文件夹名**后追加 `_1`，不覆盖、不迁移旧站数据。

每个文件夹 = 独立进程 + 独立数据库卷，互不影响。

---

## 3. 技术基底：LibreChat 套壳

### 3.1 引用声明（每个发行版 README 必含）

```markdown
## 致谢 / Attribution

本项目的 Chat UI 基于 [LibreChat](https://github.com/danny-avila/LibreChat)（MIT License）套壳改造。

- 上游仓库：https://github.com/danny-avila/LibreChat
- 改造方：PolarUI / Polarisor 生态
- 改造内容：双层侧边栏（情景-会话）、Workflow 后端、记忆三层、发行版模型

未修改部分版权归 LibreChat 作者及贡献者所有。
```

### 3.2 改造范围（POLAR 层）

| 保留（LibreChat） | 替换/新增（POLAR） |
|-------------------|-------------------|
| ChatGPT 风格 UI、流式、Markdown | 侧边栏改为 **情景 + 会话** 双层 |
| 多用户登录骨架 | 用户名直登 + admin |
| 文件上传 UI | 扩展为全格式 + zip 解码 |
| — | Workflow 代理 `POST /api/chat` |
| — | 记忆三层 SSoT（SQLite/独立卷） |
| — | 情景/会话名 LLM 自动总结 |
| — | 发行版 `site.manifest.json` |

### 3.3 侧边栏层级（导航）

**普通用户：2 层**

```
[情景栏]  [会话栏]  |  聊天区
```

**Admin：3 层（第 0 级 = 用户）**

```
[用户栏]  [情景栏]  [会话栏]  |  聊天区
   L0        L1        L2
```

| 层级 | 名称 | 内容 |
|------|------|------|
| **L0**（仅 admin） | 用户 | 所有 `user_id` 列表 |
| **L1** | 情景（任务） | 当前用户下的情景列表；**自动命名** |
| **L2** | 会话 | 当前情景下的会话列表；**自动命名** |

### 3.4 侧边栏交互

| 规则 | 说明 |
|------|------|
| 默认 | 所有侧栏隐藏（留触发条） |
| 悬停 | **同级侧栏联动展开**（admin 三栏一起，用户两栏一起） |
| 区分 | L0 深蓝 +「用户」；L1 深灰 +「情景」；L2 浅灰 +「会话」 |
| 选中 | 左侧色条 + 背景高亮 |
| 从零对话 | 首条消息后 LLM 总结 → **自动创建情景名 + 会话名** |

---

## 4. 多模态

### 4.1 入站（用户 → Web → Workflow）

| 类型 | 处理 |
|------|------|
| 图片/音频/视频 | LibreChat 既有能力 + 转文本/描述注入 message |
| 文档 pdf/docx/txt/md | 提取文本 |
| **zip** | 解压 → 递归解码内部文件 → 合并文本摘要 |
| 其他 | `file-ingest` 管道尝试解码，失败则元数据+提示 |

### 4.2 出站（Workflow → 用户）

| 类型 | 处理 |
|------|------|
| **PDF**（尤其 xelatex 生成） | 聊天气泡内 PDF 卡片 + 下载/预览 |
| 图片 | 内联展示 |
| 其他 | 附件链接 |

---

## 5. 与 Workflow 联动

发行版内 `site.manifest.json` 锁定**编译进发行版**的快照（非外部可变路径）：

```json
{
  "release_id": "taoci-outreach_1",
  "workflow_id": "taoci-outreach",
  "workflow_snapshot": "workflow/snapshot.lg.json",
  "export_entry": "cli",
  "exported_at": "2026-07-07T12:00:00+08:00"
}
```

编译流水线见 [`WEB_EXPORT.md`](./WEB_EXPORT.md)。请求契约见 [`MEMORY.md`](./MEMORY.md)。

---

## 6. 记忆查看

分层 UI 规格见 [`MEMORY.md`](./MEMORY.md) §「记忆查看 UI」——**不是**单一「我的记忆」页糊在一起。

---

## 7. 实施阶段

| 阶段 | 交付 |
|------|------|
| W0 | `_template/` = LibreChat fork + README 引用声明 |
| W1 | 双层/三层侧栏 + 悬停联动 |
| W2 | 情景/会话自动命名 + SQLite 记忆库 |
| W3 | Workflow 代理 + manifest 锁定 |
| W4 | 记忆查看分层 UI + 确认弹窗 |
| W5 | 多模态 ingest（含 zip）+ PDF 出站 |
| W6 | `export-release.mjs` 编译流水线（Web + CLI 双入口） |
| W7 | 自动化验收全绿（见 `WEB_ACCEPTANCE.md`） |
