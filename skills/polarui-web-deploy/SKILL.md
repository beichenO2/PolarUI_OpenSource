---
name: polarui-web-deploy
description: >
  把 PolarUI workflow 部署为 Web 发行版：export-release.mjs 编译导出、手写 builtin 适配器、
  外部 HTTP /run 服务注册、site.config/librechat 品牌配置、Docker 启动、验收 checklist。
  触发：部署 workflow 到 Web、导出网站、export-release、http_workflows、HTTP workflow、
  Python 服务接入、Web 发行版、LibreChat 部署、PolarChat。
---

# PolarUI Web 部署

> **导出流水线详规** → [`docs/WEB_EXPORT.md`](../../docs/WEB_EXPORT.md)  
> **三层正交铁律** → [`docs/DEPLOYMENT_SPEC.md`](../../docs/DEPLOYMENT_SPEC.md)  
> **workflow 契约** → [`polarui-workflow-contract`](../polarui-workflow-contract/SKILL.md)  
> **HTTP `/run` 规范** → [`docs/WORKFLOW_RUN_CONTRACT.md`](../../docs/WORKFLOW_RUN_CONTRACT.md) · [ADR-012](../../decisions/012-workflow-http-plugin.md)  
> **模版接入** → `~/Desktop/Web_related/_template/docs/WORKFLOW_INTEGRATION.md`

## 一句话

**Web = Workflow 发行版**：`export-release.mjs` 从 `_template/` 编译产出独立站点；复杂逻辑用 builtin `.mjs` **或** 外置 HTTP `/run` 服务接入，再 Docker 启动验收。

---

## 前置

| 项 | 要求 |
|----|------|
| 工作目录 | `~/Desktop/Web_related/`（模版 `_template/`、发行版 `{release_id}/`） |
| PolarUI workflow | `workflows/{id}/` 含 `{id}.lg.json`、`registry-entry.json`；preflight 通过 |
| PolarPrivate | LLM 端点可用（export Step 1 preflight） |
| PolarPort | `:11050` 申领端口（⛔ 禁止启发式写死端口） |

---

## Step 1：导出发行版

**双入口，同一脚本** `PolarUI/scripts/export-release.mjs`：

```bash
cd ~/Polarisor/PolarUI

# 首次导出
node scripts/export-release.mjs --workflow taoci-outreach

# 从已有发行版再导出（命名递增：_1 → _2 → _3）
node scripts/export-release.mjs --workflow taoci-outreach --from-release taoci-outreach_1

# 仅编译不部署（CI / 调试）
node scripts/export-release.mjs --workflow taoci-outreach --compile-only

# JSON 输出（Agent 解析）
node scripts/export-release.mjs --workflow taoci-outreach --json
```

PolarUI 画布顶栏 **「导出网站」** → `POST /api/export-release { workflow_id }`（内部同一脚本）。

### 编译流水线（摘要）

```
preflight → CoW clone _template/ → 编译 .lg.json / memory-schema / site.config
→ verify → PolarPort 申领端口 → PolarProcess 启动 Docker
```

产出：`~/Desktop/Web_related/{release_id}/`（含 `site.manifest.json`、`workflow/snapshot.lg.json`、`EXPORT.log`）。

⛔ **禁止** Agent 在 `Web_related/` 手写 React 组件或跳过 export 直接 mkdir。

---

## Step 2：补 builtin 适配器（按需）

export **不生成** `polar/workflows/*.mjs`。

| workflow 类型 | 操作 |
|---------------|------|
| 简单图工作流（taoci-outreach） | 可跳过；运行时走 graph-cli |
| 复杂业务（JS） | 手写 `polar/workflows/{id}.mjs` |
| 已有 Python/其他语言服务 | **跳过 builtin**；走下方「HTTP 外置 workflow」 |

契约见 [`polarui-workflow-contract`](../polarui-workflow-contract/SKILL.md)。参考：

- 最小样例：`_template/polar/workflows/demo.mjs`
- 生产样例：`~/Desktop/Web_related/market-truth-cs/polar/workflows/market-truth-cs.mjs`

---

## Step 3：品牌与配置（换 workflow 六处）

| # | 文件 | 改什么 |
|---|------|--------|
| 1 | `polar/workflows/{id}.mjs` | 新增/更新适配器 `id` / `label` / `run()` |
| 2 | `site.config.json` | `workflow_id`、`registry`、`release_id` |
| 3 | `librechat.yaml` | `appTitle`、`customWelcome`、`modelSpecs`、default model |
| 4 | `polar/public/lc/polar/polar-boot.js` | 登录页/顶栏品牌文案 |
| 5 | （可选）`polar/public/lc/assets/logo.svg` | favicon / logo |
| 6 | （可选）`docker-compose.*.yml` | 端口 override、`MTCS_*` / `POLARPRIVATE_URL` env |

多 workflow：`site.config.json` 的 `extra_workflows[]` / **`http_workflows[]`** + LC 模型选择器（`GET /v1/models` 动态拉取）。**`modelSpecs.prioritize: true` 时，HTTP workflow 上架 UI 还需在 `librechat.yaml` 的 `modelSpecs.list` 加 preset**（`preset.model` = workflow id）。

### HTTP 外置 workflow（完整路线）

**无需**改 `polar/workflows/`。任意语言实现 [`WORKFLOW_RUN_CONTRACT.md`](../../docs/WORKFLOW_RUN_CONTRACT.md) 即可插拔。

#### A. 开发服务

最小 Node demo（模版自带）：

```bash
cd ~/Desktop/Web_related/_template   # 或 market-truth-cs
node examples/http-workflow-demo/server.mjs
# 默认 :3941；curl http://127.0.0.1:3941/health
```

Python FastAPI 最小片段与字段说明见 [`polarui-workflow-contract`](../polarui-workflow-contract/SKILL.md)「HTTP `/run` 契约」。  
生产实例：`雷老师组测试任务/service/start.sh`（`mta-python`，`:3945`）。

#### B. 注册（推荐：export 直出，P2a）

**优先**在 PolarUI workflow 目录声明，由 `export-release` 写入发行版：

```json
// workflows/{id}/http-workflows.json
[
  {
    "id": "my-http-flow",
    "label": "显示名",
    "url": "http://host.docker.internal:3941/run",
    "timeout_ms": 60000
  }
]
```

或 CLI（可重复）：

```bash
node scripts/export-release.mjs --workflow {id} --compile-only \
  --http-workflow '{"id":"my-http-flow","label":"显示名","url":"http://host.docker.internal:3941/run","timeout_ms":60000}'
```

export 会同时：① 写入 `site.config.json` → `http_workflows[]`；② 补齐 `librechat.yaml` `modelSpecs.list` preset（endpoint 取模版 custom 名）。

仍可手改已有发行版的 `site.config.json`（兼容旧流程）：

```json
"http_workflows": [
  {
    "id": "my-http-flow",
    "label": "显示名",
    "url": "http://host.docker.internal:3941/run",
    "timeout_ms": 60000
  }
]
```

| 环境 | `url` host |
|------|------------|
| polar-api 在 Docker，服务在宿主机 | `host.docker.internal` |
| 本机直跑 `node polar/server.mjs` | `127.0.0.1` |

长链路 LLM：`timeout_ms` ≥ `120000`。

#### C. LibreChat preset

`modelSpecs.prioritize: true` 时需要同 id preset。**P2a export 已自动追加**；仅手改发行版时仍须手动加：

```yaml
modelSpecs:
  prioritize: true
  list:
    - name: "my-http-flow"
      label: "显示名"
      preset:
        endpoint: "<与 endpoints.custom[].name 一致>"
        model: "my-http-flow"
```

`endpoints.custom[].models.default` 可列入该 id；`fetch: true` 时列表仍以 polar-api 为准。

#### D. 重启与验收

```bash
docker restart {prefix}-polar-api {prefix}-librechat
curl -s http://127.0.0.1:{api_port}/v1/models | jq '.data[].id'
# 应出现 my-http-flow

# 可选：直打服务
curl -s http://127.0.0.1:3941/run \
  -H 'Content-Type: application/json' \
  -d '{"userId":"u001","message":"ping","memoryPayload":{},"workflowId":"my-http-flow"}'
```

LC 选该模型发消息 → SSE 回复；服务宕机时应看到「工作流服务暂时不可用（…）」而非白屏。

参考：`_template/examples/http-workflow-demo/README.md` · market-truth-cs 的 `demo-http` / `mta-python`。

---

## Step 4：构建前端 + 启动

export 默认跑 Step 0–12（编译 + 部署一体）。若改过 LC client 源码：

```bash
cd ~/Desktop/Web_related/{release_id}

# 注入 PolarPort 申领的 api 端口
VITE_POLAR_API=http://127.0.0.1:{api_port} npm run build:librechat

# 启动 Chat UI（或 export 已自动 deploy）
npm run start:librechat:detach
# 或 docker compose -f docker-compose.polar.yml up -d
```

访问 `site.config.json` 中的 `librechat_port`（PolarPort 申领，非写死 3080）。

重启 polar-api 使新 builtin 生效：

```bash
docker restart {prefix}-polar-api {prefix}-librechat
curl -s http://127.0.0.1:{api_port}/v1/models | jq '.data[].id'
```

---

## Step 5：验收 checklist

### 自动化（PolarUI 侧）

```bash
cd ~/Polarisor/PolarUI
npm run test:web-release    # unit + api + e2e
```

### 人工 / 冒烟

| # | 项 | 验证 |
|---|-----|------|
| 1 | 登录 | LC 登录成功；JWT 落盘 `localStorage.token` |
| 2 | 情景分组 | 侧栏按情景标题分组（非「昨天」日期 fallback） |
| 3 | 情景/会话切换 | 顶栏下拉；未选情景发消息被拦截 |
| 4 | 记忆面板 | 用户/情景/会话三层可读；LC Memories 前缀 `[用户]`/`[情景]` |
| 5 | 对话 + workflow | 选模型发消息 → SSE 回复；`memory_delta` 落库 |
| 6 | Admin | `http://<api_host>:<api_port>/admin` 可进；用户/记忆树可管理 |
| 7 | 记忆提取规则 | 用户记忆页可编辑提取规则；空字符串恢复默认 |
| 8 | 记忆 cap | 单层超 100 条时淘汰最旧（滚动窗口） |

### Admin 管理页（`:3920` 等 API 端口，非 LC :3080）

- 默认 **免密**：用户名 `admin` 即可
- 可选 **密码挑战应答**：`GET /api/admin/auth/challenge` → SHA256 proof → `POST /api/admin/auth/login`
- 能力：全局统计、用户/情景/会话/记忆树、级联删除

详 §12：`WORKFLOW_INTEGRATION.md`

---

## dev / release 双模式互斥

**同时只能有一个 UI 在线**。SSoT：`polar/.ui-mode` ∈ `{dev, release}`。

| 模式 | 端口（模版默认） | 启动 |
|------|------------------|------|
| `dev` | **3090** | `_template/scripts/dev.sh` |
| `release` | **3080**（或 PolarPort 申领） | Docker 发行版 / `release.sh` |

`ui-mode-gate.js` 会在端口与模式不符时整页拦截。发行版经 PolarPort 申领 `:3085/:3925` 等时逻辑一致。

---

## 禁止事项

| 禁止 | 正确做法 |
|------|---------|
| 手改发行版业务代码后不 re-export | 改 workflow / `_template` → 重新 export 新 `{release_id}` |
| 编译时写死 3920/3080 | PolarPort allocate（Step 11） |
| 跳过 preflight | 412 错误列表，不创建半成品目录 |
| GUI 与 CLI 各写导出逻辑 | 共用 `export-release.mjs` |

---

## 9 步完整 checklist（换 workflow）

| # | 步骤 |
|---|------|
| 1 | PolarUI 建图 + preflight |
| 2 | `export-release.mjs --workflow {id}` |
| 3 | 手写 `polar/workflows/{id}.mjs`（复杂 JS）**或** 跳过改走 HTTP `/run` |
| 4 | `site.config.json`（含可选 `http_workflows[]`） |
| 5 | `librechat.yaml`（含 HTTP id 的 modelSpecs preset） |
| 6 | `polar-boot.js` 品牌 |
| 7 | （可选）logo 资产 |
| 8 | `VITE_POLAR_API=… npm run build:librechat` |
| 9 | `docker restart` + `/v1/models` 验证 |

详 `_template/docs/WORKFLOW_PLUGGABILITY.md` §4。

---

## 参考实例

| 实例 | 路径 | 说明 |
|------|------|------|
| 模版 | `~/Desktop/Web_related/_template/` | 通用 PolarChat 模版 + `http-workflow` 适配器 |
| HTTP demo | `_template/examples/http-workflow-demo/` | Node `:3941` 契约样例 |
| market-truth-cs | `~/Desktop/Web_related/market-truth-cs/` | builtin + `demo-http` + `mta-python` |
| Python 服务 | `雷老师组测试任务/service/` | FastAPI `/run` 生产实例 |
| taoci-outreach | `~/Desktop/Web_related/taoci-outreach*` | graph-cli 路径 |
