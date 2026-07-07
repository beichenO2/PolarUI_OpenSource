# 网站模版 · 验收标准

> **TDD**：先写测试，再实现。全部自动化，**人不手动点验收**。

---

## 1. 测试分层

| 层 | 工具 | 目录 |
|----|------|------|
| 单元 | Node `node:test` | `polar/tests/unit/` |
| API 契约 | `node:test` + fetch | `polar/tests/api/` |
| 集成 | `node:test` | `polar/tests/integration/`（非 mock workflow、OpenAI SSE） |
| E2E | `node:test` + fetch | `polar/tests/e2e/` |
| UI（LibreChat） | Docker 官方镜像 或 `npm run build:librechat` | `upstream/librechat/` |
| 发行版脚本 | `node:test` | `PolarUI/scripts/export-release.test.mjs` |

**门禁**：`npm run test:web` 全绿方可标记 polaris feature `done`。

---

## 2. 发行版与命名

### AC-R01 首次导出（CLI）

```gherkin
Given workflow_id = "taoci-outreach" 且 Web_related 下无同名目录
When 执行 node scripts/export-release.mjs --workflow taoci-outreach
Then 创建 ~/Desktop/Web_related/taoci-outreach/
And site.manifest.json.release_id == "taoci-outreach"
And workflow/snapshot.lg.json 存在且 checksum 匹配源
And EXPORT.log 含全部 compile step
```

### AC-R01b 首次导出（PolarUI Web）

```gherkin
Given PolarUI 打开 workflow taoci-outreach
When POST /api/export-release { workflow_id: "taoci-outreach" }
Then 与 CLI 执行结果目录结构一致
And site.manifest.json.export_entry == "gui"
```

### AC-R02 递增导出

```gherkin
Given 已存在 taoci-outreach/
When 再次 export-release.mjs
Then 创建 taoci-outreach_1/（不修改 taoci-outreach/）
Given 已存在 taoci-outreach_1/
When 再次 export
Then 创建 taoci-outreach_1_1/
```

### AC-R03 发行版隔离

```gherkin
Given taoci-outreach 与 taoci-outreach_1 均运行
When 在 _1 中创建用户 alice
Then taoci-outreach 中不存在 alice
```

### AC-R04 脚本编译（禁止手写）

```gherkin
Given export-release.mjs 完成
Then release 目录含 workflow/snapshot.lg.json
And 含 config/memory-schema.json
And 含 config/required-executors.json
And 不含 workflows/ 外部符号链接
And compile_steps 数组长度 >= 6
```

### AC-R05 双入口同一实现

```gherkin
Given GUI 与 CLI 各导出一次（不同 release_id）
Then 两者 manifest.compile_steps 相同
And 两者均通过 verify-release.mjs
```

---

## 3. PolarChat 导航（情景 / 会话归属）

> UI 品牌：**PolarChat**（基于 LibreChat 套壳）。不再使用硬编码 L0/L1/L2 双侧栏 overlay；改为顶栏上下文栏 + LibreChat 原生 Project/Conversation 概念映射。

### AC-N01 普通用户顶栏上下文

```gherkin
Given 用户 guoyunyi 登录，非 admin
Then 顶栏显示 PolarChat 品牌 + powered by LibreChat
And 顶栏含「情景」下拉 + 「会话」下拉
And 无 admin 用户切换器
When 未选情景时发起 chat/completions
Then 拦截并提示「请先选择情景(Project)」
```

### AC-N02 Admin 用户切换

```gherkin
Given admin 登录
Then 顶栏显示「管理员 · 查看用户」下拉
When 选中用户 guoyunyi
Then 情景/会话下拉仅显示 guoyunyi 的数据
And GET /api/bootstrap?user_id=admin 返回 users 列表
```

### AC-N03 情景/会话选中

```gherkin
Given 顶栏上下文栏可见
When 切换情景下拉选项
Then sessionStorage.polar_scenario_id 更新
And 会话下拉刷新为该情景下的会话列表
When 切换会话下拉选项
Then sessionStorage.polar_session_id 更新
```

### AC-N04 自动命名 + 首登种子

```gherkin
Given 新用户首次登录
Then 自动创建示例情景「示例情景 · 套辞胡友财」+ 会话「首次对话」
And 三层记忆种子数据写入（user/scenario/session）
Given 无选中情景，用户发送首条消息 "想套辞胡友财老师"
When workflow 返回 ok
Then 情景名含"胡友财"或"套辞"
And 会话名非空
```

---

## 4. 记忆查看（分层）

### AC-M01 用户记忆页独立

```gherkin
When GET /memory/user
Then 响应含 layer=user 条目列表
And 不含 scenario 或 session 条目
And required 字段未填时标记 missing
```

### AC-M02 情景记忆页绑定

```gherkin
When GET /memory/scenario/{id}
Then 仅返回 owner_id=scenarioId 的 scenario 层条目
And 页面含 scenario.title 与 step 字段
```

### AC-M03 会话记忆页

```gherkin
When GET /memory/session/{id}
Then 含 timeline 摘要数组
And 含 turns_count
And raw turns 默认折叠（API 字段 collapsed=true）
```

### AC-M04 确认队列

```gherkin
Given 对话后 LLM 提议 user.major="制药工程研一"
Then memory_entries 存在 status=pending 记录
When POST /memory/confirm { id, action: "accept" }
Then status=active 且 value 已更新
When action: "reject"
Then 记录删除或 status=rejected
```

### AC-M05 Admin 跨用户查看

```gherkin
Given admin
When GET /admin/memory/user?user=guoyunyi
Then 200 且为 guoyunyi 的用户记忆
When 普通用户 guoyunyi GET /admin/memory/user?user=zhangsan
Then 403
```

---

## 5. Workflow 联动

### AC-W01 请求契约

```gherkin
When POST /api/chat { user_id, scenario_id, session_id, message, memory }
Then 调用 run-graph-cli.mjs 且入参含三层 memory JSON
And 响应含 ok, reply, memory_delta
```

### AC-W02 manifest 锁定

```gherkin
Given 发行版 taoci-outreach_1 manifest 锁定 snapshot S
When workflow 源文件已变更
Then 该发行版仍使用导出时复制的 snapshot（非自动拉最新）
```

---

## 6. 多模态

### AC-F01 zip 解码

```gherkin
Given 用户上传 resume.zip 内含 resume.pdf + photo.jpg
When POST /api/ingest
Then 返回 extracted_text 非空
And files[] 含 pdf、jpg 解码结果
```

### AC-F02 PDF 出站

```gherkin
Given workflow 返回 artifacts.pdf_path
When 渲染聊天消息
Then 消息含 application/pdf 附件
And GET pdf_path 返回 Content-Type: application/pdf
```

### AC-F03 全格式尝试

```gherkin
Given 上传 .docx .png .zip .txt
Then 每种均不 500（允许 partial 警告）
```

---

## 7. LibreChat 引用

### AC-L01 README 声明

```gherkin
Given _template/README.md
Then 含 "LibreChat" 与 "MIT" 与 upstream URL
```

---

## 8. CI 命令

```bash
# PolarUI 侧
cd PolarUI && npm run test:web-release

# 模版站侧（实现后）
cd ~/Desktop/Web_related/_template && npm run test
cd ~/Desktop/Web_related/_template && npm run test:e2e
```

---

## 9. 注意事项（实现时必读）

| # | 注意 |
|---|------|
| 1 | **不要**覆盖已有发行版目录；只追加 `_1` |
| 2 | **不要**让 workflow 更新自动同步到旧发行版 |
| 3 | LibreChat 升级需记录在 `polar/UPSTREAM.md`，合并冲突优先保留 POLAR 层 |
| 4 | admin 用户切换器仅 admin 可见；普通用户代码路径不得暴露 admin DOM |
| 5 | 记忆查看三页**禁止**合并为一个 Tab 组件 |
| 6 | 自动命名失败时降级为「新情景 / 新会话」，不得阻塞聊天 |
| 7 | zip 解压需限制大小（如 50MB）与文件数（如 100），防 zip bomb |
| 8 | 所有验收用例必须可在 CI 无头环境跑通（Playwright headless） |
| 9 | 测试数据用 `test-{uuid}` 前缀，跑完清理 |
| 10 | 发行版 manifest 必须复制 workflow 快照到发行版目录内，不引用外部可变路径 |
| 11 | **Agent 禁止**在 Web_related 手写业务代码；只能调 `export-release.mjs` |
| 12 | PolarUI Web 导出必须 spawn **同一** `export-release.mjs`，不得另写逻辑 |
