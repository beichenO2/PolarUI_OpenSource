---
name: polarui-workflow-contract
description: >
  PolarUI Web 运行时 workflow 契约：builtin .mjs / HTTP POST /run / graph-cli 三路；
  run 输入/输出、memoryPayload、memory_delta、Python FastAPI 最小实现、http_workflows 注册。
  触发：workflow 契约、/run、http_workflows、builtin 适配器、memory_delta、memoryPayload、
  graph-cli、Web 接入 workflow、polar/workflows、Python 插拔、需要什么样的 workflow。
---

# PolarUI Workflow 运行时契约

> **画布撰写**（`.lg.json`、节点、WYSIWYG）→ [`polarui-workflow-authoring`](../polarui-workflow-authoring/SKILL.md)  
> **部署到 Web** → [`polarui-web-deploy`](../polarui-web-deploy/SKILL.md)  
> **HTTP `/run` 一级规范** → [`docs/WORKFLOW_RUN_CONTRACT.md`](../../docs/WORKFLOW_RUN_CONTRACT.md) · [ADR-012](../../decisions/012-workflow-http-plugin.md)  
> **模版详规** → `~/Desktop/Web_related/_template/docs/WORKFLOW_INTEGRATION.md` · `WORKFLOW_PLUGGABILITY.md`

## 一句话

**Web 上的 workflow = 适配器函数**（或实现同一契约的 HTTP 服务）：读三层记忆快照 → 产出回复 → 可选写 `memory_delta`。  
**任意语言只要实现 `POST /run`，就能插进 Web**——这是一级设计约束。

---

## 三条运行时路径

| 路径 | 触发 | 适用 |
|------|------|------|
| **builtin** | `polar/workflows/{id}.mjs` 存在且 `export const id` 匹配模型名 | 复杂业务、自定义 LLM 链、Skill 逻辑（如 market-truth-cs JS 版） |
| **http** | `site.config.json` → `http_workflows[]` 声明外置 `POST /run` | Python/LangGraph、多语言、独立微服务；可同时挂多个 |
| **graph-cli** | 无 builtin/http；模型名 = PolarUI workflow id | 简单 PolarUI 图工作流（如 taoci-outreach） |

`registry.mjs` 约定式扫描 `polar/workflows/*.mjs`；`resolveWorkflow` 顺序：**builtin → http → graph-cli**（id 冲突时 builtin 优先）。

---

## HTTP `/run` 契约（核心）

完整规范：[`docs/WORKFLOW_RUN_CONTRACT.md`](../../docs/WORKFLOW_RUN_CONTRACT.md)。以下与已验证实现一致，可照抄。

### 请求（polar 原样转发 `run()` 入参）

```http
POST {url} HTTP/1.1
Content-Type: application/json
```

```json
{
  "userId": "u001",
  "scenarioId": "scn_xxx",
  "sessionId": "ses_xxx",
  "message": "用户本轮消息",
  "history": [
    { "role": "user", "content": "上一轮" },
    { "role": "assistant", "content": "上一轮回复" }
  ],
  "memoryPayload": {
    "user": { "公司": "某钢厂" },
    "scenario": {},
    "session": { "keypoints": [] },
    "_scopes": { "user": "u001", "scenario": "u001-scn_xxx", "session": "..." }
  },
  "config": {},
  "workflowId": "my-http-flow"
}
```

| 字段 | 说明 |
|------|------|
| `message` | **仅当前轮**（不含 LC 完整 messages） |
| `history` | **可选**；当前会话升序、不含本轮；默认最多 40 条（`history_limit`）；老服务忽略即可 |
| `memoryPayload` | `{ user, scenario, session: { keypoints }, _scopes }` |
| 其余 | 与 builtin `run(input)` 同名同义 |

### 响应（须含 `ok: boolean` + `reply: string`）

```json
{
  "ok": true,
  "reply": "展示给用户的回复文本",
  "memory_delta": {
    "user": { "k": "v" },
    "scenario": { "k": "v" },
    "session": { "k": "v" }
  }
}
```

- `memory_delta.user` / `scenario` → pending；`session` → active
- 业务失败：HTTP 200 + `{ "ok": false, "reply": "原因" }`
- 壳侧超时/网络/非法 JSON → `{ ok:false, reply:"工作流服务暂时不可用（…）" }`（不抛异常）

### 注册 `site.config.json`

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

Docker 内 polar-api 访问宿主机用 `host.docker.internal`；本机直跑用 `127.0.0.1`。

### `librechat.yaml` preset（`modelSpecs.prioritize: true` 时必须）

```yaml
modelSpecs:
  enforce: false
  prioritize: true
  list:
    - name: "my-http-flow"
      label: "显示名"
      description: "外置 HTTP workflow"
      preset:
        endpoint: "情报客服工作流"   # 与 endpoints.custom[].name 一致
        model: "my-http-flow"       # = http_workflows[].id
```

`endpoints.custom[].models.default` 可把该 id 列入兜底列表；`models.fetch: true` 时仍以 `GET /v1/models` 为准。

### Python FastAPI 最小实现（可照抄）

与 `_template/examples/http-workflow-demo/README.md` 及已验证服务字段一致：

```python
from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import Any

app = FastAPI()

class RunInput(BaseModel):
    userId: str = "anonymous"
    scenarioId: str | None = None
    sessionId: str | None = None
    message: str = ""
    memoryPayload: dict[str, Any] = Field(default_factory=dict)
    config: dict[str, Any] = Field(default_factory=dict)
    workflowId: str = "my-python-flow"

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/run")
def run(body: RunInput):
    user = body.memoryPayload.get("user") or {}
    hint = ""
    if isinstance(user, dict) and user:
        k, v = next(iter(user.items()))
        hint = f" | 记忆 user.{k}={v}"
    return {
        "ok": True,
        "reply": f"[{body.workflowId}] {body.message}{hint}",
        "memory_delta": {"session": {"py_demo": "1"}},
    }
```

```bash
uvicorn main:app --host 0.0.0.0 --port 3941
```

生产参考（cheatAgent 完整实例）：`雷老师组测试任务/service/web_workflow_service.py` + `service/README.md`（`mta-python`，`:3945`，`timeout_ms` ≥ 120000）。

### 无状态 / 安全（摘要）

- **History（已标准化）**：壳侧从 turns 注入可选 `history[]`（升序、不含本轮、默认上限 40 / `history_limit`）；服务可忽略以保持向后兼容。详见契约「history 标准化」。
- **安全**：内网明文可接受；公网须鉴权（Roadmap）。

---

## builtin 模块契约

### 导出要求

```js
export const id = 'my-flow';          // 可选，缺省 = 文件名（不含 .mjs）
export const label = '显示名';         // 可选，缺省 = id

export async function run(input) {
  return { ok: true, reply: '...', memory_delta: { /* 可选 */ } };
}
```

### 输入 `run(input)`

与 HTTP 请求 body **同一套字段**（见上表）。多轮上下文优先读可选 `history[]`；亦可继续依赖三层记忆。平台不再要求服务自管进程内对话 dict。

### 输出

| 字段 | 类型 | 落库策略 |
|------|------|----------|
| `ok` | `boolean` | 控制错误展示 |
| `reply` | `string` | 写入 turns + SSE 回 LC |
| `memory_delta.user?` | `{ k: v }` | `status: pending` |
| `memory_delta.scenario?` | `{ k: v }` | `status: pending` |
| `memory_delta.session?` | `{ k: v }` | `status: active` |
| `pdf_path?` | `string \| null` | 可选产物路径 |

### 最小示例

参考 `~/Desktop/Web_related/_template/polar/workflows/demo.mjs`（polar-demo）。

---

## graph-cli 路径（零代码适配器）

模型名直接用 PolarUI workflow id（如 `taoci-outreach`）。polar-api spawn：

```bash
node lib/run-graph-cli.mjs \
  --workflow <id> \
  --conversation-id <sessionId> \
  --message <text> \
  --user-id <uid> \
  --memory-json '<threeLayerJson>'
```

- stdout 可混日志；polar 只解析**末尾 JSON**（`extractTailJson`）
- 图 Output 节点须产出 `{ ok, reply, memory_delta?, pdf_path? }`
- `site.config.json` 可声明 `workflow_id` + `extra_workflows[]` 上架图工作流

---

## 记忆集成要求

### workflow 职责（业务槽位）

1. **读**：从 `memoryPayload.user / scenario / session` 注入 prompt 或路由逻辑
2. **写**：返回 `memory_delta` 中业务字段
3. **user 层**：workflow **只读**；若需写 user 事实，经 `memory_delta.user` → pending 队列

### 正交模块（workflow 零负担）

```
process-chat.mjs
  → workflow.run()           → memory_delta（workflow 产出）
  → memory-extractor         → mergeMemoryDelta（workflow 键优先）
  → db.addMemoryEntry()
```

| 能力 | 说明 |
|------|------|
| 默认中文提取规则 | `polar/lib/memory-extractor.mjs` |
| 用户可编辑规则 | 记忆页「记忆提取规则」→ `GET/PUT /api/memory/extraction-rules` |
| 容量 cap | 每层每 scope 最多 **100** 条 |

### scope_key

| 层 | DB scope_key |
|----|--------------|
| user | `{user_id}` |
| scenario | `{user_id}-{scenario_id}` |
| session | `{user_id}-{scenario_id}-{session_id}` |

三层记忆与 workflow id **无关**；换模型不丢记忆。

---

## LLM 调用

builtin 内需 LLM 时，**必须**复用发行版共享客户端：

```js
import { chatCompletions } from '../lib/llm-client.mjs';
```

⛔ 不要在适配器内硬编码 API key（除非走外置 HTTP 服务，由该服务自行管密钥）。

---

## 何时选哪条路径

| 场景 | 推荐 |
|------|------|
| PolarUI 图已表达全部逻辑、节点 executor 齐全 | graph-cli |
| 复杂 Skill / 条件分支难用图表达，且用 JS | **builtin 手写** |
| Python/LangGraph 已有实现、需 Web 复用 | **http_workflows**（实现 `/run`） |

export **不自动生成** `polar/workflows/*.mjs`；复杂 JS workflow 导出后须手写 builtin。HTTP 路径**无需** `.mjs`。

---

## 参考

| 文档 / 代码 | 路径 |
|-------------|------|
| **`/run` 一级契约** | `PolarUI/docs/WORKFLOW_RUN_CONTRACT.md` |
| ADR-012 | `PolarUI/decisions/012-workflow-http-plugin.md` |
| 接入指南 | `_template/docs/WORKFLOW_INTEGRATION.md` |
| 插拔性 + checklist | `_template/docs/WORKFLOW_PLUGGABILITY.md` |
| HTTP demo | `_template/examples/http-workflow-demo/` |
| 适配器源码 | `_template/polar/lib/http-workflow.mjs` |
| Python 生产实例 | `雷老师组测试任务/service/` |
| 记忆设计 | `PolarUI/docs/MEMORY.md` |
