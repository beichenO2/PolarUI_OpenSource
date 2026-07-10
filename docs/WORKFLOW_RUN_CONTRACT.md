# Workflow HTTP `/run` 契约

> **地位**：一级设计约束——**任何语言实现了本契约，就能插进 PolarUI Web 发行版**。  
> **决策**：[`ADR-012`](../decisions/012-workflow-http-plugin.md)  
> **操作**：[`skills/polarui-workflow-contract`](../skills/polarui-workflow-contract/SKILL.md) · [`skills/polarui-web-deploy`](../skills/polarui-web-deploy/SKILL.md)  
> **已验证实现**：`~/Desktop/Web_related/_template/polar/lib/http-workflow.mjs` · `examples/http-workflow-demo/` · market-truth-cs Python 服务

---

## 一句话

Web 壳（polar-api）对外部 workflow 的**唯一**插拔约束是：服务暴露 `POST /run`，入参/出参 JSON 与 builtin `run()` 一致。语言、框架、内部状态机任意。

---

## 三路分发（polar registry）

`resolveWorkflow` 顺序：

1. **builtin** — `polar/workflows/*.mjs`（id 冲突时优先）
2. **http** — `site.config.json` → `http_workflows[]`
3. **graph-cli** — PolarUI 图工作流兜底

HTTP 路径由通用适配器 `polar/lib/http-workflow.mjs` 完成：原样 `JSON.stringify(input)` POST 到配置的 `url`。

---

## 请求：`POST {url}`

| 项 | 值 |
|----|-----|
| Method | `POST` |
| Content-Type | `application/json` |
| Body | polar `run()` 完整入参（见下表） |

### 请求 JSON schema

```json
{
  "userId": "u001",
  "scenarioId": "scn_xxx",
  "sessionId": "ses_xxx",
  "message": "用户本轮消息",
  "history": [
    { "role": "user", "content": "上一轮用户消息" },
    { "role": "assistant", "content": "上一轮助手回复" }
  ],
  "memoryPayload": {
    "user": { "公司": "某钢厂" },
    "scenario": {},
    "session": { "keypoints": [] },
    "_scopes": {
      "user": "u001",
      "scenario": "u001-scn_xxx",
      "session": "u001-scn_xxx-ses_xxx"
    }
  },
  "config": {},
  "workflowId": "my-http-flow"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `userId` | `string` | 建议有 | polar 用户名（LC 邮箱前缀） |
| `scenarioId` | `string \| null` | 否 | 当前情景 id |
| `sessionId` | `string \| null` | 否 | 当前会话 id |
| `message` | `string` | **是** | **仅当前轮**用户消息（不含 LC 完整 messages 数组） |
| `history` | `Array<{role, content}>` | 否 | 当前会话历史（见下节）；缺省时老服务忽略即可 |
| `memoryPayload` | `object` | 建议有 | 三层记忆快照：`user` / `scenario` / `session.keypoints` / `_scopes` |
| `config` | `object` | 否 | `site.config.json` 解析结果（服务端可忽略） |
| `workflowId` | `string` | 否 | 即 LC 模型名 / `http_workflows[].id` |

---

## 响应

必须返回 JSON，且 **`ok` 为 boolean、`reply` 为 string**（适配器校验；否则视为格式无效并降级）。

```json
{
  "ok": true,
  "reply": "展示给用户的回复文本",
  "memory_delta": {
    "user": { "k": "v" },
    "scenario": { "k": "v" },
    "session": { "k": "v" }
  },
  "pdf_path": null
}
```

| 字段 | 类型 | 必填 | 落库 / 行为 |
|------|------|------|-------------|
| `ok` | `boolean` | **是** | 控制错误展示 |
| `reply` | `string` | **是** | 写入 turns + SSE 回 LibreChat |
| `memory_delta.user?` | `{ k: v }` | 否 | `status: pending`（待用户确认） |
| `memory_delta.scenario?` | `{ k: v }` | 否 | `status: pending` |
| `memory_delta.session?` | `{ k: v }` | 否 | `status: active`（直接生效） |
| `pdf_path?` | `string \| null` | 否 | 可选产物路径 |

业务失败时仍应返回 HTTP 200 + `{ "ok": false, "reply": "原因" }`，便于 Web 壳把文案展示给用户。

---

## 错误与超时语义（Web 壳友好降级）

适配器**不向调用方抛异常**；网络/超时/非法响应一律降级为：

```json
{ "ok": false, "reply": "工作流服务暂时不可用（{reason}）" }
```

| 情况 | `reason` 示例 |
|------|----------------|
| HTTP 非 2xx | `HTTP 502` |
| 响应体非 JSON | `响应非 JSON` |
| 缺 `ok`/`reply` 或类型不对 | `响应格式无效` |
| 超过 `timeout_ms`（默认 60000） | `超时` |
| 连接失败等 | `网络错误` / `fetch failed` |

服务侧应尽量自返回 `{ ok:false, reply }`；壳侧降级是兜底，保证 Chat UI 不白屏。

---

## history 标准化（已实现）

Web 壳（`process-chat.mjs`）从 turns 落库组装可选字段 `history`，随 `run()` 入参原样转发给 builtin / http / graph-cli 三路，**消除服务进程内对话内存态**（多 worker / 重启不丢上下文）。

| 约定 | 说明 |
|------|------|
| 字段 | `history: [{ role: "user" \| "assistant", content: string }, ...]` |
| 范围 | **当前会话**按时间**升序**；**不含本轮** `message` |
| 上限 | 默认 **40** 条；`site.config.json` 可配 `history_limit`（正整数） |
| 来源 | polar turns 表（`appendTurn` 之前读取） |
| 向后兼容 | **可选字段**；老服务忽略 `history` 照常工作；缺省 / 非法数组时 PolarFlow 不注入 `input.history` |
| 与记忆并存 | PolarFlow 仍保留内部 conversation 记忆；flow 作者可选用 `{{input.history}}` 或自管记忆 |

示例（第三轮请求体片段）：

```json
{
  "message": "第三轮",
  "history": [
    { "role": "user", "content": "第一轮" },
    { "role": "assistant", "content": "回1" },
    { "role": "user", "content": "第二轮" },
    { "role": "assistant", "content": "回2" }
  ]
}
```

`site.config.json` 可选：

```json
"history_limit": 40
```

---

## 安全边界

| 环境 | 现状 | 要求 |
|------|------|------|
| 局域网 / Docker `host.docker.internal` | **明文 HTTP**，无鉴权 | Demo / 内网可接受 |
| 公网 | **未覆盖** | 须加 token / mTLS 等（Roadmap：契约鉴权） |

当前 `http-workflow.mjs` 不附加 Authorization；公网部署前勿直接暴露 `/run`。

---

## `site.config.json` 注册

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

| 字段 | 说明 |
|------|------|
| `id` | = LibreChat 模型名；与 builtin 冲突时 **builtin 优先**，http 条目跳过并 `console.warn` |
| `label` | `GET /v1/models` 展示名（增强 label 见 Roadmap） |
| `url` | 完整 POST 地址（通常以 `/run` 结尾） |
| `timeout_ms` | 可选，默认 60000；长链路 LLM 建议 ≥ 120000 |

同文件顶层还可配 `history_limit`（正整数，默认 40），控制壳侧注入的 `history` 条数上限。

- Docker 内 polar-api → 宿主机服务：`http://host.docker.internal:<port>/run`
- 本机直跑 `node polar/server.mjs`：`http://127.0.0.1:<port>/run`

若 `librechat.yaml` 设置 `modelSpecs.prioritize: true`，还须在 `modelSpecs.list` 增加同 id 的 preset，否则 UI 下拉可能不出现。

---

## 可选健康检查

约定（非强制）：`GET /health` → `{ "ok": true, ... }`。适配器不依赖它；运维与冒烟用。

---

## 参考实现（字段名以这些为准）

| 产物 | 路径 |
|------|------|
| 通用适配器 | `_template/polar/lib/http-workflow.mjs` |
| Node 零依赖 demo | `_template/examples/http-workflow-demo/` |
| 契约 README | `_template/examples/http-workflow-demo/README.md` |
| Python 生产实例 | `雷老师组测试任务/service/web_workflow_service.py`（`mta-python`，`:3945`） |
| 插拔调研 | `_template/docs/WORKFLOW_PLUGGABILITY.md` §6 |

*文档版本：2026-07-10 · 与已验证实现字段名、错误文案对齐*
