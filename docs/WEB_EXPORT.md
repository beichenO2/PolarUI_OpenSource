# Web 发行版导出

> **网站规格**：[`WEB_TEMPLATE.md`](./WEB_TEMPLATE.md) · **验收**：[`WEB_ACCEPTANCE.md`](./WEB_ACCEPTANCE.md)

---

## 1. 核心原则

| 原则 | 说明 |
|------|------|
| **脚本生成，禁止手写** | 网站由 `export-release.mjs` 流水线**编译**产出；Agent **不得**直接写网站代码 |
| **双入口，同一脚本** | PolarUI Web 按钮 与 CLI 均调用同一导出脚本 |
| **Workflow 逐一编译** | 从 workflow 目录按清单提取、变换、写入发行版 |
| **发行版冻结** | 导出物自包含；不引用可变源路径 |

---

## 2. 双入口

```
                    ┌─────────────────────────┐
                    │  scripts/export-release.mjs │  ← 唯一实现
                    └───────────┬─────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
    PolarUI Web「导出网站」                  CLI / Agent
    POST /api/export-release              node scripts/export-release.mjs
    或 spawn 同脚本                         --workflow taoci-outreach
```

### 2.1 入口 A：PolarUI Web

| 项 | 说明 |
|----|------|
| 位置 | 画布顶栏 / 部署面板 → **「导出网站」** |
| 行为 | 收集当前打开的 `workflow_id` → 调 `export-release.mjs` |
| 参数 | `--workflow {id}`；可选 `--from-release {当前最新发行版名}` |
| 反馈 | 进度 JSON 流；成功返回 `release_path` + `release_id` |
| 失败 | preflight 错误列表（同 deploy-preflight） |

### 2.2 入口 B：CLI（Agent 专用）

```bash
cd ~/Polarisor/PolarUI

# 首次导出
node scripts/export-release.mjs --workflow taoci-outreach

# 从已有发行版再导出（命名递增）
node scripts/export-release.mjs --workflow taoci-outreach --from-release taoci-outreach_1

# 仅编译不启动
node scripts/export-release.mjs --workflow taoci-outreach --compile-only

# JSON 输出（Agent 解析）
node scripts/export-release.mjs --workflow taoci-outreach --json
```

**Agent 职责**：调用 CLI、读 JSON 结果、报告路径。**禁止**在 `~/Desktop/Web_related/` 手写 `.tsx` / `.mjs` 建站。

---

## 3. 编译流水线（Workflow → Web）

导出 = **逐步编译**，不是复制整个 PolarUI。

```
export-release.mjs
  │
  ├─ Step 0  resolveReleaseId()      # 命名：原名 / 原名_1 / 原名_1_1
  ├─ Step 1  preflight()             # deploy-preflight-cli
  ├─ Step 2  scaffoldTemplate()      # 复制 _template/（固定基底）
  ├─ Step 3  compileWorkflowGraph()  # .lg.json → release/workflow/
  ├─ Step 4  compileRegistry()       # registry-entry.json → manifest 元数据
  ├─ Step 5  compileMemorySchema()   # WORKFLOW.spec + 图节点 → memory schema
  ├─ Step 6  compilePrompts()        # workflows/*/prompts/ → release/prompts/
  ├─ Step 7  compileExecutors()      # 所需 executor 列表 → site.services.json
  ├─ Step 8  compilePolarConfig()    # 生成 site.config.json + site.manifest.json
  ├─ Step 9  patchLibreChat()        # 注入 polar/ 配置
  ├─ Step 10 verifyRelease()         # 结构校验 + EXPORT.log
  ├─ Step 11 claimPorts              # PolarPort 申请 api + librechat 端口（⛔ 禁止启发式写死）
  └─ Step 12 deploy                  # SOTAgent 注册 + PolarProcess start
```

**默认**：CLI 与 Web UI 均跑 Step 0–12（编译 + 部署一体）。仅 `--compile-only` 时跳过 11–12。

---

## 3.1 记忆管理（网站 SSoT ↔ Workflow）

> 详规：[`MEMORY.md`](./MEMORY.md)

### 分工

| 层 | 谁存 | 谁算 |
|----|------|------|
| **网站发行版** `data/store.json` | 权威存储 | 侧栏、记忆页、确认队列 |
| **Workflow 图** | 不直连 DB | 读 snapshot、写 `memory_delta` |

### scope_key（append 防串味）

| 层 | Workflow JSON key | DB `scope_key` |
|----|-------------------|----------------|
| 用户 | `user` | `{user_id}` |
| 情景 | `scenario` | `{user_id}-{scenario_id}` |
| 会话 | `session` | `{user_id}-{scenario_id}-{session_id}` |

聊天时网站组装 `--memory-json`：

```json
{
  "user": { "major": "..." },
  "scenario": { "step": "S1_Research" },
  "session": { "keypoints": [] },
  "_scopes": {
    "user": "alice",
    "scenario": "alice-sc-uuid",
    "session": "alice-sc-uuid-ss-uuid"
  }
}
```

Workflow 返回 `memory_delta` 后，网站按层写入 `memory_entries`；用户层 LLM 提议 → `status=pending` → 确认队列。

### 文件布局（每个发行版独立）

```
{release_id}/data/store.json   ← users / scenarios / sessions / memory_entries / turns
{release_id}/workflow/snapshot.lg.json   ← 冻结图（导出后不变）
{release_id}/config/memory-schema.json ← 导出时编译的 schema + scope_key_format
```

---

## 3.2 端口与部署（PolarPort + PolarProcess）

⛔ **禁止** `3920 + hash(release_id)` 等编译时启发式端口。

| Step | 组件 | 行为 |
|------|------|------|
| 11 | **PolarPort** `:11050` | `POST /api/allocate` → `web-{release_id}-api`、`web-{release_id}-lc` |
| 12 | **SOTAgent** `:4800` | `POST /api/services` 注册 command/work_dir/health_check_url |
| 12 | **PolarProcess** `:11055` | `POST /api/services/{id}/start` 启动进程 |

成功后写入：

- `site.config.json` → `port`、`librechat_port`、`polarport`
- `polar/injected/deploy.json` → `api_url`、`chat_url`、`service_id`

### 双入口（自动化，同一脚本）

| 入口 | 调用 |
|------|------|
| **CLI** | `node scripts/export-release.mjs --workflow taoci-outreach --json` |
| **PolarUI Web** | `POST /api/export-release { workflow_id }` → 内部 `exportRelease({ exportEntry:'gui' })` |

返回示例：

```json
{
  "ok": true,
  "release_id": "taoci-outreach_1",
  "release_path": "~/Desktop/Web_related/taoci-outreach_1",
  "deploy": {
    "api_url": "http://127.0.0.1:3920/",
    "chat_url": "http://127.0.0.1:3080/",
    "service_id": "web-taoci-outreach_1-api"
  }
}
```

仅编译、不部署：`--compile-only`（测试 / CI 用）。

### Chat UI 标准部署（每个发行版固定流程）

`export-release.mjs` 从 `~/Desktop/Web_related/_template/` **整包复制**到 `{release_id}/`，因此以下文件随每次 export 自动带上，**不是单个 release 的手工改动**：

| 组件 | 路径 | 作用 |
|------|------|------|
| `polar-boot.js/css` | `polar/public/polar/` | PolarChat 品牌 + 用户名直登 + 情景(Project)/会话归属顶栏 + 分层记忆面板 + chat 上下文 |
| `seed-workspace.mjs` | `polar/lib/` | 首登自动创建示例情景/会话 + 三层记忆种子数据 |
| `librechat-auth.mjs` | `polar/lib/` | 服务端代建 LibreChat session（避免浏览器 429） |
| `docker-compose.polar.yml` | 发行版根 | PolarChat（LibreChat 套壳）+ polar-api + mongo |
| `librechat-docker-boot.sh` | `scripts/` | 容器启动时注入 polar-boot 到 LC index.html |
| `librechat.yaml` | 发行版根 | custom endpoint → `polar-api:3920/v1`；欢迎语标注 PolarChat |

**PolarChat UI 设计要点**（不修改 LibreChat 上游源码）：

| 概念 | Polar 层 | LibreChat 原生 | 说明 |
|------|---------|---------------|------|
| 情景 | `scenario` | **Project**（`/api/projects`） | 登录后 polar-boot 自动 sync；DOM 标签改为「情景」 |
| 会话 | `session` | **Conversation**（`/c/{id}`） | 通过 `lc_conversation_id` 映射 |
| 用户记忆 | `user` layer | LC Memories 面板 | fetch hook 替换 `/api/memories` → 前缀 `[用户]` |
| 情景记忆 | `scenario` layer | LC Memories 面板 | 同上，前缀 `[情景]` |
| 会话记忆 | `session` layer | — | 仅 runtime 注入 workflow，**不在 Memories 面板展示** |
| 管理员 | `admin` 用户 | — | 顶栏用户切换器，可查看任意用户的情景/记忆 |
| ID 映射 | `polar/routes/sync.mjs` | — | `POST/GET /api/sync/lc` 维护 lc_project_id / lc_conversation_id |

上线 Chat 前端（export 后执行一次）：

```bash
cd ~/Desktop/Web_related/{release_id}
npm run start:librechat:detach
```

访问 `site.config.json` 里的 `librechat_port`（默认 3080）。

---

## 3.3 逐步编译清单

| Step | 输入（workflow 内） | 输出（发行版内） | 编译器 |
|------|-------------------|----------------|--------|
| 3 | `{id}/{id}.lg.json` | `workflow/snapshot.lg.json` | 原样复制 + checksum |
| 4 | `registry-entry.json` | `manifest.registry.json` | JSON 提取 |
| 5 | `WORKFLOW.spec.md` + 图内记忆节点 | `config/memory-schema.json` | `compile-memory-schema.mjs` |
| 6 | `prompts/*.md` | `prompts/*.md` | 原样复制 |
| 7 | 图 `class_type` 集合 | `config/required-executors.json` | 从 lg.json 扫描 |
| 8 | 上述合并 | `site.config.json`, `site.manifest.json` | `compile-site-config.mjs` |
| 9 | `polar/` 模板片段 | `polar/injected/` | 变量替换（workflow_id, port…） |

### 3.2 site.manifest.json（编译产物）

```json
{
  "release_id": "taoci-outreach_1",
  "workflow_id": "taoci-outreach",
  "exported_at": "2026-07-07T13:30:00+08:00",
  "export_entry": "cli",
  "compile_steps": ["graph", "registry", "memory-schema", "prompts", "executors", "config"],
  "workflow_snapshot": "workflow/snapshot.lg.json",
  "workflow_checksum": "sha256:...",
  "memory_schema": "config/memory-schema.json",
  "web_root": "~/Desktop/Web_related/taoci-outreach_1"
}
```

`export_entry`: `"gui"` | `"cli"`

---

## 4. 目录结构（编译后）

```
~/Desktop/Web_related/taoci-outreach_1/
├── site.manifest.json          # Step 8 生成
├── site.config.json            # Step 8 生成
├── EXPORT.log                  # Step 10 编译日志
├── workflow/
│   └── snapshot.lg.json        # Step 3
├── config/
│   ├── memory-schema.json      # Step 5
│   └── required-executors.json # Step 7
├── prompts/                    # Step 6（若有）
├── polar/                      # Step 9 注入
│   └── injected/
├── [LibreChat 基底文件...]     # Step 2 来自 _template/
└── README.md                   # 含 LibreChat Attribution + release_id
```

---

## 5. 禁止事项

| 禁止 | 正确做法 |
|------|---------|
| Agent 在 Web_related 写 React 组件 | 改 `_template/polar/` 模版 + 重跑 export |
| Agent 手改发行版内业务代码 | 改 workflow → 重新 export 新 `_1` 发行版 |
| 导出时引用 `PolarUI/workflows/` 可变路径 | manifest 只指向发行版内 `workflow/snapshot.lg.json` |
| GUI 与 CLI 各写一套导出逻辑 | 共用 `export-release.mjs` |
| 跳过 compile step 直接 mkdir | 必须跑 Step 0–10 |
| 编译时写死端口 | 必须 Step 11 PolarPort allocate |
| 手动 `npm start` 上线 | 必须 Step 12 PolarProcess start |

---

## 6. PolarUI Web 集成（FRONTEND）

画布 **导出网站** 按钮：

```javascript
// 伪代码 — 实现时 spawn 同 CLI
const r = await fetch('/api/export-release', {
  method: 'POST',
  body: JSON.stringify({ workflow_id: currentWorkflowId }),
});
// → { ok, release_id, release_path, manifest }
```

Vite dev 代理或 PolarClaw 转发至 `node scripts/export-release.mjs`。

详见 [`FRONTEND.md`](./FRONTEND.md) § 导出网站。

---

## 7. 脚本文件（PolarUI 侧）

| 文件 | 职责 |
|------|------|
| `scripts/export-release.mjs` | 主编排（双入口共用，含 deploy） |
| `scripts/claim-polar-port.mjs` | PolarPort allocate |
| `scripts/deploy-web-release.mjs` | 注册 + PolarProcess 启动 |
| `scripts/compile-memory-schema.mjs` | WORKFLOW.spec + lg.json → schema |
| `scripts/compile-site-config.mjs` | site.config / manifest（port 初始 null） |
| `scripts/verify-release.mjs` | 发行版结构校验 |
| `scripts/export-release.test.mjs` | AC-R01~03 + 编译步骤测试 |

---

## 8. 与 deploy-preflight 关系

导出前 **必须** preflight 通过（Step 1）。  
未通过 → 两入口均返回 412 + 错误列表，**不创建**发行版目录。
