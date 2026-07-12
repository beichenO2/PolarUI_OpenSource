# Web 发行版导出

> **网站规格**：[`WEB_TEMPLATE.md`](./WEB_TEMPLATE.md) · **验收**：[`WEB_ACCEPTANCE.md`](./WEB_ACCEPTANCE.md) · **三层正交铁律**：[`DEPLOYMENT_SPEC.md`](./DEPLOYMENT_SPEC.md)

---

## 1. 核心原则

| 原则 | 说明 |
|------|------|
| **脚本生成，禁止手写** | 网站由 `export-release.mjs` 流水线**编译**产出；Agent **不得**直接写网站代码 |
| **双入口，同一脚本** | PolarUI Web 按钮 与 CLI 均调用同一导出脚本 |
| **Workflow 逐一编译** | 从 workflow 目录按清单提取、变换、写入发行版 |
| **发行版冻结** | 导出物自包含；不引用可变源路径（详见 [`DEPLOYMENT_SPEC.md`](./DEPLOYMENT_SPEC.md) §2–§3） |

---

## 2. 双入口

```
                    ┌─────────────────────────────┐
                    │  scripts/export-release.mjs │  ← 唯一实现
                    └───────────┬─────────────────┘
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

# P2a：导出时直出 http_workflows（可重复；也可放 workflows/{id}/http-workflows.json）
node scripts/export-release.mjs --workflow taoci-outreach --compile-only \
  --http-workflow '{"id":"demo-http","label":"HTTP Demo","url":"http://host.docker.internal:3941/run","timeout_ms":60000}'
```

**Agent 职责**：调用 CLI、读 JSON 结果、报告路径。**禁止**在 `~/Desktop/Web_related/` 手写 `.tsx` / `.mjs` 建站。

### 2.3 P2a：`http_workflows` 配置直出（ADR-012）

导出时把外置 HTTP `/run` 服务写进发行版，无需手改 `site.config.json` / `librechat.yaml`。

| 来源 | 说明 |
|------|------|
| `workflows/{id}/http-workflows.json` | **推荐**：JSON 数组，字段 `id`/`url` 必填，可选 `label`/`description`/`timeout_ms` |
| `registry-entry.json` → `http_workflows[]` | 无专用文件时的备选 |
| CLI `--http-workflow '<json>'` | 可多次；与文件合并；**重复 id 报错** |

流水线行为：

1. Step 8 `compile-site-config` → `site.config.json.http_workflows[]`
2. Step 9 patch → 为每条缺失项追加 `librechat.yaml` `modelSpecs.list` preset（`endpoint` = 模版 `endpoints.custom[0].name`，`model` = id），并列入 `models.default`

```json
// workflows/my-flow/http-workflows.json
[
  {
    "id": "mta-python",
    "label": "Python 情报客服",
    "url": "http://host.docker.internal:3945/run",
    "timeout_ms": 120000,
    "description": "LangGraph via HTTP"
  }
]
```

---

## 3. 编译流水线（Workflow → Web）

导出 = **逐步编译**，不是复制整个 PolarUI。

```
export-release.mjs
  │
  ├─ Step 0  resolveReleaseId()      # 命名：原名 / 原名_1 / 原名_2 …（数字递增，不再 _1_1）
  ├─ Step 1  preflight()             # deploy-preflight-cli
  ├─ Step 2  scaffoldTemplate()      # CoW clone _template/（APFS clonefile；排除 node_modules）
  ├─ Step 3  compileWorkflowGraph()  # {id}.json → release/workflow/snapshot.json
  ├─ Step 4  compileRegistry()       # registry-entry.json → manifest 元数据
  ├─ Step 5  compileMemorySchema()   # WORKFLOW.spec + 图节点 → memory schema
  ├─ Step 6  compilePrompts()        # workflows/*/prompts/ → release/prompts/
  ├─ Step 7  compileExecutors()      # 图节点 class_type 扫描（兼容编号键格式）→ required-executors
  ├─ Step 8  compilePolarConfig()    # 生成 site.config.json + site.manifest.json
  ├─ Step 9  patchLibreChat()        # 注入 polar/ 配置 + README release 注记
  ├─ Step 10 verifyRelease()         # 结构 + JSON 可解析 + checksum 复核 + executors 非空
  ├─ Promote staging → release/      # 原子 rename；失败自动清理 staging，不留半成品
  ├─ Step 11 claimPorts              # PolarPort 申请 api + librechat 端口（⛔ 禁止启发式写死）
  └─ Step 12 deploy                  # PolarProcess register-and-start；失败自动释放已占端口
```

**默认**：CLI 与 Web UI 均跑 Step 0–12（编译 + 部署一体）。仅 `--compile-only` 时跳过 11–12。

**管线属性（2026-07-09 重构）**：

| 属性 | 说明 |
|------|------|
| **原子性** | 全部编译在 `webRoot/.staging-*` 进行，verify 通过后 rename 到 `{release_id}/`；任何失败自动删 staging，`~/Desktop/Web_related/` 不会出现半成品目录 |
| **命名数字递增** | `taoci-outreach → _1 → _2`；`--from-release taoci-outreach_1` 会归约到基名再取下一个空位（历史 `_1_1` 目录不受影响，仅不再产生新的） |
| **CoW 快速 scaffold** | `COPYFILE_FICLONE` 克隆 + 排除 `node_modules`（模板 155k 文件中的 87%）；LibreChat 运行走 Docker 镜像、`polar/server.mjs` 零依赖，故 node_modules 仅构建期需要——在发行版内重建 client 前先在 `upstream/librechat` 跑 `npm ci` |
| **结构化日志** | `EXPORT.log`（人读，含每步耗时）+ `EXPORT.log.json`(机器读)；每步完成即落盘 |
| **统一错误契约** | 一律 resolve `{ ok:false, stage, error }`（stage ∈ input/preflight/compile/promote/deploy…）；CLI 按 ok 定 exit code；Web 入口按 stage 映射 HTTP（input→400、preflight→412、其余→500） |
| **deploy 失败降级** | 编译产物保留（可稍后重部署），已占端口回滚释放（PolarPort `/api/release`），`site.config.json` 仅在服务真正启动后才写入端口 |

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
{release_id}/workflow/snapshot.json   ← 冻结图（导出后不变）
{release_id}/config/memory-schema.json ← 导出时编译的 schema + scope_key_format
```

---

## 3.3 JWT 鉴权链与情景侧栏（ADR-009）

PolarChat **不是**「有数据就能分组」：侧栏情景标题来自 `GET /api/bootstrap`，须带有效 LibreChat JWT。

### 故障特征（修复前）

- Network：`/api/bootstrap` 401；侧栏显示「昨天」日期分组
- 顶栏情景为空或强制新建
- LC 主界面仍可用（axios 已 refresh），Polar 侧车全挂（localStorage 仍是过期 token）

### 修复要点（已合入 `_template`）

| 模块 | 文件 |
|------|------|
| token 单一来源 | `client/src/polar/auth-token.ts` |
| bootstrap/sync 401 重试 | `client/src/polar/api.ts` |
| 活跃会话指针 | `client/src/polar/chat-context.ts` |
| refresh 落盘 | `AuthContext.tsx` + `data-provider/request.ts` |

### 发行版构建

export 复制 `_template` 后，若改过 client 源码，须在发行版内重建 client 并注入申领端口：

```bash
cd ~/Desktop/Web_related/{release_id}
VITE_POLAR_API=http://127.0.0.1:{api_port} npm run build:librechat
docker compose ... restart librechat   # 挂载 polar/public/lc → client/dist
```

详规：`decisions/009-polar-jwt-auth-chain.md` · `_template/docs/WORKFLOW_INTEGRATION.md` §8

---

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
| **LC 源码修改** | `upstream/librechat/client/src/polar/` | PolarLogin、PolarScenarioBar、api/auth-token、情景侧栏分组 |
| `polar-boot.js/css` | `polar/public/polar/` | fetch hook：Memories 分层、chat 上下文 header、LC↔Polar ID sync |
| `seed-workspace.mjs` | `polar/lib/` | 首登自动创建示例情景/会话 + 三层记忆种子数据 |
| `librechat-auth.mjs` | `polar/lib/` | 服务端代建 LibreChat session（避免浏览器 429） |
| `docker-compose.polar.yml` | 发行版根 | PolarChat（LibreChat 套壳）+ polar-api + mongo |
| `librechat.yaml` | 发行版根 | custom endpoint → `polar-api:3920/v1`；欢迎语标注 PolarChat |

**PolarChat UI 架构（源码修改 + runtime hook，非 overlay 登录）**：

| 层 | 位置 | 职责 |
|----|------|------|
| **源码级** | `upstream/librechat/client/src/polar/` | 登录、顶栏情景/会话、admin 切换 → `npm run build:librechat` |
| **Runtime** | `polar/public/polar/polar-boot.js` | fetch hook：Memories 代理、chat header、LC ID 同步 |

| 概念 | Polar 层 | LibreChat 原生 | 说明 |
|------|---------|---------------|------|
| 情景 | `scenario` | **Project**（`/api/projects`） | 顶栏「情景」下拉；登录后 polar-boot sync |
| 会话 | `session` | **Conversation**（`/c/{id}`） | 顶栏「会话」下拉；`lc_conversation_id` 映射 |
| 用户记忆 | `user` layer | LC Memories 面板 | fetch hook → 前缀 `[用户]` |
| 情景记忆 | `scenario` layer | LC Memories 面板 | fetch hook → 前缀 `[情景]` |
| 会话记忆 | `session` layer | — | 仅 runtime 注入 workflow |
| 管理员 | `admin` 用户 | — | 顶栏「查看用户」下拉 |
| ID 映射 | `polar/routes/sync.mjs` | — | `lc_project_id` / `lc_conversation_id` |

**实现状态（WEB_ACCEPTANCE §3，测试-开发循环 SSOT）**：

| AC | 状态 | 验证 |
|----|------|------|
| AC-N01 顶栏情景/会话 + 未选拦截 | ✅ | `navigation.test.mjs`（源码）+ `navigation-api.test.mjs`（OpenAI 400/200） |
| AC-N02 admin 切换 | ✅ | 同上 + bootstrap `target_user` API |
| AC-N03 sessionStorage / 情景记忆切换 | ✅ | 源码测试 + memories 随 `scenario_id` 变化 API |
| AC-N04 首登种子 | ✅ | `seed-bootstrap.test.mjs` |
| Memories 分层读 | ✅ | `lc-sync.test.mjs` |
| LC Memories 写代理 | ✅ | `lc-memories-write.test.mjs` + polar-boot POST/PATCH/DELETE |
| LC Conversation 同步 | ✅ | polar-boot `syncConversation` + `lc-sync.test.mjs` |
| OpenAI SSE + workflow | ✅ | `integration/workflow-openai.test.mjs` |
| workflow memory_delta 三层持久化 | ✅ | `memory-delta.test.mjs` |
| 全链路 QA（登录→记忆→对话） | ✅ | `full-chain-qa.test.mjs`（12 项；`POLAR_LIVE_QA=1` 打 Docker） |
| LC UI 复用（情景侧栏 + 记忆 Tab + §3 路由页） | ✅ | `PolarScenarioNav` + `PolarMemoryTabs` + `PolarMemoryPages` + `PolarSessionSummaryPanel` |
| **JWT 鉴权链 + 情景侧栏联动** | ✅ | ADR-009；`auth-token.ts` + polarFetch 401 自愈；2026-07-10 合入 `_template` |

**仍待下轮（P4，可选增强）**：

| 项 | 说明 |
|----|------|
| LC Projects API 会话分组 | v0.7.9 client 无 Project 会话树；侧栏情景按钮 + LC 会话列表已替代 |
| 记忆页 Profile/Skills 分组 Tab | §3.2 完整 schema 分组 UI（当前 Table + 必填完成度已实现核心） |

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
| 3 | `{id}/{id}.json`（兼容 `{id}.lg.json`） | `workflow/snapshot.json` | 原样复制 + checksum |
| 4 | `registry-entry.json` | `manifest.registry.json` | JSON 提取 |
| 5 | `WORKFLOW.spec.md` + 图内记忆节点 | `config/memory-schema.json` | `compile-memory-schema.mjs` |
| 6 | `prompts/*.md` | `prompts/*.md` | 原样复制 |
| 7 | 图 `class_type` 集合 | `config/required-executors.json` | 从 lg.json 扫描 |
| 8 | 上述合并 + 可选 `http_workflows[]` | `site.config.json`, `site.manifest.json` | `compile-site-config.mjs` |
| 9 | `polar/` 模板片段 + HTTP modelSpecs | `polar/injected/` + `librechat.yaml` patch | 变量替换 + `patch-librechat-http-workflows.mjs` |

### 3.2 site.manifest.json（编译产物）

```json
{
  "release_id": "taoci-outreach_1",
  "workflow_id": "taoci-outreach",
  "exported_at": "2026-07-07T13:30:00+08:00",
  "export_entry": "cli",
  "compile_steps": ["graph", "registry", "memory-schema", "prompts", "executors", "config"],
  "workflow_snapshot": "workflow/snapshot.json",
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
│   └── snapshot.json        # Step 3
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
| 导出时引用 `PolarUI/workflows/` 可变路径 | manifest 只指向发行版内 `workflow/snapshot.json` |
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
| `scripts/export-release.mjs` | 主编排（双入口共用，含 deploy；staging 原子化 + 结构化日志） |
| `scripts/graph-utils.mjs` | workflow 图节点读取（编号键 + 传统 nodes[] 双格式兼容） |
| `scripts/claim-polar-port.mjs` | PolarPort allocate |
| `scripts/deploy-web-release.mjs` | 注册 + PolarProcess 启动（失败回滚端口） |
| `scripts/compile-memory-schema.mjs` | WORKFLOW.spec + lg.json → schema |
| `scripts/compile-site-config.mjs` | site.config / manifest（port 初始 null；可选 `http_workflows[]`） |
| `scripts/http-workflows.mjs` | 从 `http-workflows.json` / registry / CLI 加载声明 |
| `scripts/patch-librechat-http-workflows.mjs` | 为 http workflow 追加 librechat modelSpecs preset |
| `scripts/verify-release.mjs` | 结构 + JSON + checksum + executors 校验 |
| `scripts/export-release.test.mjs` | AC-R01~05 + 原子性 / 命名 / 校验 / P2a 回归测试 |

---

## 8. 与 deploy-preflight 关系

导出前 **必须** preflight 通过（Step 1）。  
未通过 → 两入口均返回 412 + 错误列表，**不创建**发行版目录。
