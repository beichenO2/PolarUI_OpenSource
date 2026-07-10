# ADR-013 残留业务模块重构为项目引用地图（Project Map）

- 状态：accepted
- 日期：2026-07-10
- 前置：ADR-011（双服务瘦身，遗留"残留待清"清单）
- 进度追踪：`polaris.json` **R9**

## 背景

ADR-011 P3 后，`src/engine` 剩六个业务残留文件（checkup-inbox-client / checkup-runner /
checkup-vlm / ecosystem-architecture / ssot-compiler / ssot-actions，共约 836 行），
仍被 SSoT / 健康两个 Tab 引用。用户决策（2026-07-10 Hub 批注）：**不删除，重构**——
用 PolarUI 可视化管理 Polarisor 生态项目，看到**引用结构**。

现状问题：

1. `ecosystem-architecture.ts` 的"生态架构图"是硬编码健康拓扑（Hub→ProcessList→
   HealthCheck→SelfHeal），**不是**项目间真实引用。
2. 生态里约 22 个 `polaris.json` 的跨项目引用字段不统一：`depends_on: string[]`、
   `depends_on: {project, reason, endpoint}[]`、PolarDesign 的 `upstream`/`downstream`、
   或缺失。
3. checkup-vlm 是孤立模块（无引用）。

## 决策

### D1 项目引用地图 = SSoT 视图的一等公民

在 SSoT Tab 的生态地图侧栏增加「项目引用图」入口：把全生态项目 + 归一化后的
`depends_on` 引用画到主画布——节点 = `SSoT_Project`（带 tier/status/完成度），
边 = 引用关系（reason 作为 label 元数据）。点击项目节点仍可下钻单项目需求树
（复用 `compileSsotToGraph`）。

### D2 依赖归一化为纯函数（可单测）

新建 `src/engine/project-deps.ts`：
`extractProjectDependencies(polaris: unknown): { project: string; reason?: string }[]`
统一解析三种 `depends_on` 形态 + `upstream`/`downstream`，容忍缺失与注释字符串。
`buildDependencyGraph(projects, depsMap): Graph` 产出画布图，dagre 自动布局，
按 tier 用 `_groups` 分组。

### D3 数据获取走既有 Hub 通道

`scanEcosystem()` 拿项目清单后，并行 `GET /api/polaris/{name}` 拉各项目 polaris，
失败的项目降级为无出边的孤立节点（不阻塞整图）。

### D4 六文件处置

| 文件 | 处置 |
|------|------|
| ecosystem-architecture.ts | 健康拓扑图保留；依赖图逻辑放新 project-deps.ts |
| ssot-compiler.ts | 保留，扫描函数复用 |
| ssot-actions.ts | 保留（Up to date / 执行未完成项按钮） |
| checkup-runner / inbox-client | 保留（健康 Tab 守护） |
| checkup-vlm.ts | 保留待接（孤立，标注 TODO，不在本次范围） |

## 验收

- QA 新增 `tests/engine/project-deps.test.ts`（三种 depends_on 形态、upstream/downstream、
  缺失字段、自引用/未知项目边过滤、图无悬空边），`npm run qa` 全绿。
- GUI：SSoT Tab 可一键生成项目引用图，节点可下钻。
