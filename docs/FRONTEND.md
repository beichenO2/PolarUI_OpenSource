# PolarUI 前端使用

> **SSoT 入口**：[`SSoT.md`](./SSoT.md)

---

## 启动

```bash
cd ~/Polarisor/PolarUI
npm run build    # 首次或改 src/ 后：源码 → dist/assets/
npm run dev -- --port 5170
```

`npm run dev` 会同步 `node-defs/` 到 `dist/`、刷新 GUI overlay / 导出按钮脚本，再启动 Vite。

打开 **http://127.0.0.1:5170/**

`vite.config.mjs` 会：
- 从 `dist/` 提供静态资源（bundle 来自 `npm run build`）
- `/node-defs/*` → 顶层 `node-defs/`（SSoT，dev 中间件）
- `/api/polaris/PolarUI` → 本地 `polaris.json`（Hub 未开也能加载 SSoT）
- `/api/services`、`/api/watchdog` → PolarProcess :11055（经 proxy，无 CORS）

---

## 加载套辞 workflow

**没有「LG 模式 / WF 模式」切换 Tab**（已删除）。直接：

1. 左侧 **Workflow** 面板 → 找到 **套辞助手 Taoci Outreach**
2. 或 **打开 JSON** → 选 `workflows/taoci-outreach/taoci-outreach.json`

生产 workflow 统一使用 **`.json`** 后缀。图内含 `_entry` / `_lg_edges` 元数据时，引擎自动启用步进单路径执行（ADR-010）；**`.lg.json` 仅作兼容读取**（旧图/测试图）。

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
| `Failed to resolve import "./taoci-graph/register.mjs"` | `dist/overlay/gui-overlay.mjs` 仍是旧版（含 Node import） | 跑 `npm run build` 或 `npm run dev`（已内置 overlay 刷新） |
| `loadProjectSsot ... Unexpected token '<'` | `/api/polaris` 返回了 HTML | 用 `npm run dev`（含 vite.config.mjs），勿裸起静态服 |
| CORS `:11055/api/services` | bundle 直连 PolarProcess | 用 `npm run dev`（vite proxy 已配置） |
| Hub 8040 连不上 | PolarCopilot 未启动 | SSoT 仍可从本地 polaris.json 读；Hub 功能需另启 |

---

## 分组折叠（Group）

就地折叠（ComfyUI / Blender 式），**仅视图层**——`_groups` 写入 workflow JSON，成员节点与连线原样保留，**执行引擎完全无感知**。

| 操作 | 方式 |
|------|------|
| 折叠为组 | Shift+点击多选 ≥2 节点 → 顶栏「折叠为组」或快捷键 **G** → 输入组名 |
| 展开 | 双击折叠后的组框 |
| 整组拖动 | 展开状态下拖标题栏 |
| 解散 | 选中组 → 右侧属性面板「解散组」 |
| 自动建议 | 顶栏「自动分组建议」→ 虚线预览框 → 右键/点击预览采纳 |

`_groups` schema：`[{ id, title, node_ids: string[], collapsed: boolean, color?: string }]`

---

## 已废弃说法（勿用）

- ~~「切到 LG 模式」~~ — UI Tab 已删
- ~~「LangGraph 模式」~~ — 同上
- 正确：直接打开 `.json` workflow；状态机由 Switch + `_lg_edges` 表达；含 `_entry`/`_lg_edges` 的图自动步进执行
