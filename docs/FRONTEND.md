# PolarUI 前端使用

> **SSoT 入口**：[`SSoT.md`](./SSoT.md)

---

## 启动

```bash
cd ~/Polarisor/PolarUI
npm run dev -- --port 5170
```

`npm run dev` 会自动执行 `patch:gui-overlay`（浏览器 executor）和 `patch-dev-ecosystem-fetch`（API 相对路径），再启动 Vite。

打开 **http://127.0.0.1:5170/**

`vite.config.mjs` 会：
- 从 `dist/` 提供静态资源
- `/api/polaris/PolarUI` → 本地 `polaris.json`（Hub 未开也能加载 SSoT）
- `/api/services`、`/api/watchdog` → PolarProcess :11055（经 proxy，无 CORS）

---

## 加载套辞 workflow

**没有「LG 模式 / WF 模式」切换 Tab**（已删除）。直接：

1. 左侧 **Workflow** 面板 → 找到 **套辞助手 Taoci Outreach**
2. 或 **打开 JSON** → 选 `workflows/taoci-outreach/taoci-outreach.lg.json`

`.lg.json` 后缀和 JSON 内 `_library: "LG"` 是**执行引擎内部标记**（状态机单路径执行），不是 UI 模式开关。

---

## 画布上能看到什么（状态机）

```
PromptInput → WorkingMemory → UserMemoryLoad → ScenarioMemoryLoad → Switch（多路分支）
                                                    ├─ LLM 链 (S0)
                                                    ├─ SubAgent 链 (S1)
                                                    ├─ LLM 链 (S2)
                                                    └─ LLM 链 (S3)
                                              每路 → ScenarioMemorySave → Output
```

## 导出网站

画布 dev 模式右下角 **「导出网站」** 按钮 → `POST /api/export-release` → 调用 `scripts/export-release.mjs`（与 CLI 同一脚本）。

```bash
node scripts/export-release.mjs --workflow taoci-outreach --skip-preflight --compile-only --json
```

产出目录：`~/Desktop/Web_related/{release_id}/`

---

| 可见 | 说明 |
|------|------|
| Switch 节点 | 棕色「多路分支」，正文「分支: 4 路」 |
| 四路子图 | Switch 下方 fan-out |
| 条件 | 点选 Switch → 右侧 `cases` JSON（`when` / `label`） |
| 运行回放 | 跑完后顶栏「Run 回放」滑块（按实际路径高亮） |

**不显眼的部分**：连线上默认无 `when` 标签；`_state_schema` 不渲染。见 roadmap 状态机 UX 改进。

---

## 常见控制台报错

| 报错 | 原因 | 处理 |
|------|------|------|
| `Failed to resolve import "./taoci-graph/register.mjs"` | `dist/overlay/gui-overlay.mjs` 仍是旧版（含 Node import） | 跑 `npm run patch:gui-overlay` 或 `npm run dev`（已内置） |
| `loadProjectSsot ... Unexpected token '<'` | `/api/polaris` 返回了 HTML | 用 `npm run dev`（含 vite.config.mjs），勿裸起静态服 |
| CORS `:11055/api/services` | bundle 直连 PolarProcess | 跑 `patch-dev-ecosystem-fetch.mjs` + vite proxy |
| Hub 8040 连不上 | PolarCopilot 未启动 | SSoT 仍可从本地 polaris.json 读；Hub 功能需另启 |

---

## 已废弃说法（勿用）

- ~~「切到 LG 模式」~~ — UI Tab 已删
- ~~「LangGraph 模式」~~ — 同上
- 正确：直接打开 `.lg.json` workflow；状态机由 Switch + `_lg_edges` 表达
