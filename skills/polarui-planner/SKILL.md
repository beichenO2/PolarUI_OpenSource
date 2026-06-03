# PolarUI 规划模块（Planning Module）

将"Polar Claw"概念重定义为**规划模块**——一个基于逻辑链的工作流规划器，
使用 LLM Proxy（PolarPrivate `/v1/chat/completions`）进行推理，
以反身性为起点进行自组织规划。

> **口径 SSOT**：`任务书/Done/260523_整理归档/260523/00_PolarUI_口径与设计整合.md`  
> PolarUI 是**多范式工作流 IDE**（**WF** 与 **LG** 并列，共用节点 palette）。Planner 产出 **WF** workflow JSON；WF 产物一旦 `executeGraph` 即 frozen。**LG 工作流不在此规则内**（执行期 state/路由可变）。

---

## 模块定位

| 维度 | 说明 |
|------|------|
| 旧名 | Polar Claw |
| 新名 | **规划模块**（Planning Module） |
| 核心能力 | 接收目标描述 → LLM 推理 → 输出可执行逻辑链（工作流 JSON） |
| 本质 | 工作流 = 逻辑链；规划 = 构建逻辑链的过程 |
| 反身性 | 规划器首先明确自身组件清单，再组织逻辑链 |

---

## 设计原则

### 1. 反身性（Self-Reflection）

规划模块在生成逻辑链之前，**必须先内省当前可用组件**：

1. 扫描 PolarUI 节点注册表（`registry.getAll()`），获取全部可用节点定义
2. 扫描当前模式下可用的约束规则（Agent_core principles）
3. 将组件清单 + 约束规则作为 system prompt 的一部分注入 LLM

这意味着规划器不是"凭空想象"逻辑链，而是**在明确的组件空间内**进行组合规划。

### 2. Agent 约束纳入

规划模块将以下 Agent_core 约束作为规划上下文：

- **P1 复杂度控制**：优先复用已有节点 > 组合 > 新建
- **P4 先设计后执行**：复杂目标先分解再编排
- **P4a 新增即重构**：新增节点需检查与既有逻辑的关系
- **Proto-C 提交协议**：规划结果产出后自动触发保存

### 3. LLM Proxy 集成

通过 PolarPrivate 统一网关调用 LLM：

```
POST http://127.0.0.1:12790/v1/chat/completions
{
  "model": "<user-selected-model>",
  "messages": [
    { "role": "system", "content": "<组件清单 + 约束规则>" },
    { "role": "user", "content": "<用户目标描述>" }
  ]
}
```

端口发现优先级：`POLARPRIVATE_URL` > `POLARPRIVATE_PORT` > 默认 12790。

---

## 逻辑链结构

工作流本质上是一条**逻辑链**，由以下元素组成：

```
[目标分解] → [节点选择] → [参数填充] → [连线编排] → [验证] → [输出]
```

### RetryLoop 优先（默认反馈环）

用户定稿：**凡含 LLM 且产出可核验，默认使用 RetryLoop**（见 `任务书/Done/260523_整理归档/260523/13_RetryLoop_Agent优先原则.md`）。

**推荐子结构**：

```
PromptInput → LLM → Validator → RetryLoop → Output
                      ↑_______________|
              retry_input 回流（轮内修正；max_retries 默认 **7** = 轮间刷新验收次数）
```

- **Planner** 生成 workflow 时默认 Validator + RetryLoop；Validator 须对齐**用户需求**
- **Cursor Agent** 见 [13_RetryLoop_Agent优先原则.md](../../../任务书/Done/260523_整理归档/260523/13_RetryLoop_Agent优先原则.md) §4.3：**轮内**改到达标；**轮间**刷新上下文、对用户需求重新验收（**不**把 error log 贴进下一轮）

规划模块的输出是标准 PolarUI 工作流 JSON：

```json
{
  "1": { "class_type": "PromptInput", "inputs": { "content": "..." } },
  "2": { "class_type": "LLM", "inputs": { "prompt": ["1", 0], "model": "qwen3" } },
  "3": { "class_type": "Validator", "inputs": { "content": ["2", 0] } },
  "4": { "class_type": "RetryLoop", "inputs": { "passed": ["3", 0], "retry_hint": ["3", 2], "original_input": ["1", 0] } },
  "5": { "class_type": "Output", "inputs": { "content": ["2", 0] } }
}
```

（简例：完整 RetryLoop 回流须将 `4.retry_input` 接回 `2.prompt`；Planner 产出时须补全回边。）

---

## SSoT 模式增强

### 生态地图（Ecosystem Map）

切换到 SSoT 模式后，左侧面板从「节点」切换为「生态地图」：

| 普通模式 | SSoT 模式 |
|----------|-----------|
| 节点（palette） | 生态地图（项目文件夹 + polaris.json） |
| 按 category 分组 | 按项目分组，展示 SSoT 状态 |
| 拖拽添加节点 | 点击 → 编译为画布表示 |

### 双面板支持

SSoT 模式下，面板顶部提供切换：`[生态地图] | [节点]`

- **生态地图**：展示所有含 `polaris.json` 的生态项目
- **节点**：保留 SSoT 类节点（SSoT_Project / Requirement / Feature 等）

### SSoT 文件编译

点击生态地图中的项目 → 读取该项目 `polaris.json` → 转换为 PolarUI 画布节点图：

1. `polaris.json` 根 → `SSoT_Project` 节点
2. `requirements[]` → 每个生成 `SSoT_Requirement` 节点，连接到 Project
3. `requirements[].features[]` → 每个生成 `SSoT_Feature` 节点，连接到 Requirement
4. 状态渲染：done=绿色高亮，blocked=红色边框，in_progress=蓝色脉冲

---

## 节点定义

规划模块引入以下新节点：

### Planner（规划器）

- class_type: `Planner`
- category: `规划模块`
- 输入：`goal`(string) — 用户的目标描述
- 输出：`workflow`(object), `reasoning`(string), `components_used`(object)
- 参数：
  - `model`: LLM 模型选择（默认 qwen3）
  - `strategy`: 规划策略 — `linear`(线性) / `parallel`(并行) / `iterative`(迭代)
  - `max_depth`: 逻辑链最大深度（默认 5）
  - `reflect`: 是否启用反身性扫描（默认 true）
  - LLM 调用经 `@/sdk/llm-proxy`（固定 `http://127.0.0.1:12790`）

### PlanValidator（规划验证器）

- class_type: `PlanValidator`
- category: `规划模块`
- 输入：`workflow`(object) — 待验证的工作流
- 输出：`valid`(boolean), `issues`(object), `suggestions`(string)
- 参数：
  - `check_connectivity`: 检查节点连通性（默认 true）
  - `check_types`: 检查类型兼容性（默认 true）
  - `check_cycles`: 检查循环引用（默认 true）

### EcosystemScanner（生态扫描器）

- class_type: `EcosystemScanner`
- category: `规划模块`
- 输入：无
- 输出：`projects`(object), `ssot_map`(object)
- 参数：
  - `root_path`: 生态根目录（默认 `~/Polarisor`）
  - `include_archived`: 包含已归档项目（默认 false）

---

## 实现路径

1. `src/nodes/planner.ts` — 规划模块节点定义 + LLM 调用逻辑
2. `src/sdk/llm-proxy.ts` — PolarPrivate LLM Proxy SDK（端口 12790）
3. App.vue 节点面板 — SSoT 模式下增加「生态地图 / 节点」切换
4. `src/engine/ssot-compiler.ts` — polaris.json → PolarUI 节点图编译器

---

## 触发条件

- 用户在 PolarUI 拖入 `Planner` 节点并填入目标后执行
- SSoT 模式下点击生态地图中的项目文件
- 通过 PolarClaw 节点的 prompt 间接触发（PolarClaw 内部调用规划模块）

---

## 约束

- 新建/修改 **executor 组件实现** 须遵循 `PolarUI/.cursor/skills/polarui-component/SKILL.md`（条件/循环/赋值/计算均须中文注释）
- Planner **产出**的 workflow JSON 须按 `PolarUI/.cursor/skills/polarui-workflow/SKILL.md` 验收（compile-check、RetryLoop、registry）
- LLM 调用必须经过 PolarPrivate（不直接调外部 API）
- 规划输出必须是合法 PolarUI 工作流 JSON（所有节点类型来自注册表）
- 反身性扫描结果缓存 30 秒，避免每次规划重复扫描
- 生态地图数据从本地文件系统读取，不经过网络
