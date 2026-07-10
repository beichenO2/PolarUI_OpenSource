# ADR-010 单引擎统一与纯粹化重构（QA 门禁先行）

- 状态：accepted
- 日期：2026-07-10

## 背景

四个积累的结构性问题：

1. **LG/WF 双轨遗留**：`executeGraph` 内 `library==="LG"` 硬分叉（由 `patch-lg-runner.mjs` 注入 bundle），`.lg.json` 双后缀、LG_* 影子节点、双份 Agent 图（`hermes-1to1.json` vs `hermes.lg.json`）并存。路线之分不是本质——本质是 workflow 的稳定语义 + 可视化引擎。
2. **不纯粹**：飞书渠道（`lib/feishu-im/`、FeishuIM/FeishuRelay 节点）、IDE/PolarClaw 接口（`lib/hub-send-prompt/`、IDEAgent/WebAgent、GUI 内 PolarClaw 探测）混入。PolarUI 应回归 Workflow 本身；对外只保留基于 LibreChat 模版的一键 Web 导出（ADR-008）。
3. **画布**：自研 A* 排线 bug 多观感差（`libavoid.wasm` 在 dist 但从未加载）；无 Group/Subgraph 就地折叠能力，大图不可读。
4. **自进化跑不起来**：StemCell/PetriDish/evolution-loop 的源 workflow、cron 脚本、TS 执行器全部缺失，日志全是 ENOENT/404，属半成品。

**根因技术债**：`src/`（Vue 画布 + 图引擎 82 文件）不在工作树也不在 HEAD，最后存在于 `116523c`（2026-06-10）；此后一个月的演进全靠 7 个 `patch-*.mjs` 对 2.1MB minified bundle 做文本替换。四个问题的修复都被它卡住。

## 决策

1. **QA 门禁先行（TDD）**：先对**当前 dist 行为**写引擎特征化 golden 测试（拓扑执行、`_lg_edges` 条件路由、Switch 分支、ToolCall ReAct 回环、RetryLoop、ForLoop、state 累积），加上现有绿测试聚合为单命令 `npm run qa`。此后每个阶段以 `npm run qa` 全绿为合并门禁。
2. **恢复源码**：从 `116523c` 恢复 `src/`，把 patch 脚本编码的语义（lg-runner、toolcall branch 输出、headless entry、gui-overlay boot、export button、qcsa proxy）回放进源码，重建 bundle，QA 全绿证明重建等价。此后删除 post-build patch 机制。
3. **单一执行模型**：保留 WF 引擎稳定语义（拓扑、ForLoop、RetryLoop 外环、runTrace），把 LG 能力降为**图特性**而非第二引擎——图含 `_entry`/`_lg_edges` 即自动启用步进单路径模式。删除 `library` 分叉、`.lg.json` 后缀区分、LG_* 影子节点、`patch-lg-runner.mjs`。
4. **纯粹化**：删除飞书与 IDE/PolarClaw 接口（node-defs 声明、lib 插件层、bundle executor、polarclaw-*/feishu-* workflow 与相关测试、`@larksuiteoapi/node-sdk` 依赖）。R5 飞书渠道从「搁置」改为「移出 PolarUI」——渠道接入属部署层，永不回到 workflow 引擎。
5. **自进化归档**：全部自进化资产（evolve.json 保留为设计稿、evolution-loop.json 保留为 spec，其余 dist 产物/数据/日志）按 P10a 归档 ClawBin。未来若重做，从 TDD 重写，不在现有半成品上迭代。
6. **画布重做**（源码恢复后）：排线接入成熟避障方案（优先评估已有的 libavoid.wasm，其次 ELK edge routing），修复拖拽期路由失效；新增 Group/Subgraph 节点 schema（选中 N 节点 → 折叠为带端口投影的父节点，就地折叠，非 drill-down）；建立排线 waypoint 快照 + Playwright 截图基线测试。

## 阶段与门禁

| 阶段 | 内容 | 门禁 |
|------|------|------|
| P0 | QA 流水线：清 package.json 死脚本、引擎 golden 测试、`npm run qa` | qa 全绿 |
| P1 | src/ 恢复 + patch 语义回放 + 重建 | 同一套 qa 仍全绿 |
| P2 | LG/WF 单引擎合并 | qa 全绿 + 生产 workflow 不变 |
| P3 | 飞书/IDE 剥离 | qa 全绿（删除相应用例） |
| P4 | 自进化归档 | qa 全绿 |
| P5 | 排线 + Subgraph | qa 全绿 + 新画布测试绿 |

## 影响

- 生产 workflow `taoci-outreach`、`market-truth-cs` 语义不变（qa 保护）。
- `export-release` Web 导出链路不变（ADR-008 继续有效）。
- ADR-003（ToolCall 复合组件）能力保留，`_lg_edges` 路由并入统一引擎。
- 废弃：`patch-lg-runner.mjs`、`patch-toolcall-executor.mjs`、LG_* 节点、polarclaw-*/feishu-* workflow、自进化 dist 产物。
