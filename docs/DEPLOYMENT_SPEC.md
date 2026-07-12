# 三层部署规范 · 层间正交铁律

> **生态所有者裁定（2026-07-12）**：WorkFlow — Web Demo — 独立 Web 项目，每一层之间**完全独立正交**，不存在任何「脐带」关系。
>
> **关联文档**：[`WEB_EXPORT.md`](./WEB_EXPORT.md)（导出流水线）· [`ARCHITECTURE.md`](./ARCHITECTURE.md)（两阶段隔离）· [`WEB_ACCEPTANCE.md`](./WEB_ACCEPTANCE.md)（自动化门禁）· ADR-005（测试/部署隔离）

---

## 1. 三层定义

| 层 | 代号 | 所在项目 | 典型入口 | 职责边界 |
|----|------|----------|----------|----------|
| **WorkFlow** | L1 | PolarFlow / PolarUI | PolarFlow 编辑器 `:8125` + API `:8120`；PolarUI `lib/run-graph-cli.mjs` / headless 引擎 | **工作流开发态**：编辑 `flow.json` / workflow `.json`，mock/live 调试，校验图与节点；只管数据 IO，不管用户身份与 Chat 壳 |
| **Web Demo** | L2 | PolarUI | 画布内联调、PolarUI dev `:5170`、PolarClaw `/api/workflow/chat`（开发调试） | **联调预览态**：在开发机上把 workflow 接到 Chat 预览，验证契约与记忆 delta；**不是**对外交付物 |
| **独立 Web 项目** | L3 | PolarUI `export-release.mjs` 产出 | `~/Desktop/Web_related/{release_id}/` 或任意目标机（如 `~/Desktop/Server/TaoCi`） | **可部署发行版**：LibreChat 壳 + polar 侧车 + 内置/外置 workflow 引擎；自包含、可搬迁、可长期运行 |

### 层间关系（铁律图示）

```
┌─────────────────────────────────────────────────────────────────┐
│  L1 WorkFlow          PolarFlow :8120 / PolarUI headless        │
│  （开发机上的工作流源码与调试）                                      │
└───────────────────────────────┬─────────────────────────────────┘
                                │  编译导出（单向、冻结快照）
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  L2 Web Demo          PolarUI 画布预览 / dev 联调                 │
│  （开发机上的预览，可临时指向 L1 服务 — 仅限 L2 内）                  │
└───────────────────────────────┬─────────────────────────────────┘
                                │  export-release.mjs
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  L3 独立 Web 项目      {release_id}/ 整包部署到目标机               │
│  （交付物：与 L1/L2 零脐带、零共享开发服务）                         │
└─────────────────────────────────────────────────────────────────┘

禁止：L3 ──脐带──► L1 开发机端口 / 路径 / 共享进程 / **开发机**保险库代理

允许：L3 ──同机标配──► 目标机 PolarPrivate（:12800 API / :12805 GUI）— 见 §2.4
```

**与 ADR-005 的关系**：ADR-005 规定「测试开发 vs 部署」两阶段隔离；本规范将其细化为**三层正交**，并明确 **L3 交付后不得回指 L1/L2 运行时**。

---

## 2. 铁律：层间完全独立正交

> **一句话**：独立 Web 项目（L3）部署到任何机器后，必须能**仅凭发行版目录 + 本机 `.env`/密钥**运行；不得依赖开发机上的任何进程、端口、路径或保险库代理。

### 2.1 禁止清单（脐带禁令）

| # | 禁令 | 说明 | 典型违规 |
|---|------|------|----------|
| B1 | **禁止引用开发机端口** | L3 配置、代码、compose、`.env` 不得硬编码或默认指向开发机生态端口 | `http://127.0.0.1:8120`（PolarFlow API）、`:12790`（PolarPrivate 代理）、`:11050`（PolarPort）、`:11055`（PolarProcess）、`:5170`（PolarUI dev）、`:8125`（PolarFlow 编辑器） |
| B2 | **禁止 symlink 指向开发机路径** | 发行版内不得存在指向 `~/Polarisor/...` 或其他开发机绝对路径的符号链接 | `engine/vendor/polarflow → ~/Polarisor/PolarFlow` |
| B3 | **禁止依赖开发机共享服务进程** | L3 不得假定开发机上 PolarFlow / PolarPrivate / PolarPort / PolarProcess 正在运行 | workflow LLM 节点转发到开发机 `:8120`；侧车 `memory-extractor` 连开发机 `:12790` |
| B4 | **禁止密钥依赖开发机保险库运行时代理** | API Key、SMTP 授权码等**不得**运行时透传**开发机** PolarPrivate（`:12790` 等）；同机 PolarPrivate（Server 标配 `:12800`）见 §2.4，**不算脐带** | 未配置 `.env` 时 fallback 到 `127.0.0.1:12790`（开发机）；L3 误连开发机 Vault |
| B5 | **禁止 L3 回读 L1 可变源码** | 发行版 workflow 必须为**冻结快照**（`workflow/snapshot.json` 或内置引擎目录）；不得 `import` 开发树 | 侧车直接 `require` 开发机 `PolarFlow/src` |
| B6 | **禁止跨层隐式环境继承** | 部署到目标机时不得依赖 shell profile、开发机全局 env、IDE 注入变量 | 仅 `export-release` 时在本机 preflight 通过，搬到 Server 后 silently break |

### 2.2 L2 例外（仅限开发机）

Web Demo（L2）在**开发机**上联调时，**可以**临时指向 L1 服务（如 `http_workflows[].url` → `:8120`）。该配置**不得**原样进入 L3 发行版；导出流水线须改写为 L3 自包含方案（内置引擎端口如 `:8065`、或目标机自有 HTTP `/run` 端点）。

### 2.3 L3 自包含要求（正面清单）

| 组件 | L3 要求 |
|------|---------|
| **Workflow 引擎** | 内置引擎（发行版 `engine/` 真复制）**或** 明确注册的外置 HTTP `/run`（URL 指向**同一部署拓扑内**可达地址，如 `host.docker.internal:{本机端口}`） |
| **LLM** | 同机 PolarPrivate 无 key 代理（§2.4 规则 2）或发行版 `.env` 直连；**禁止**开发机 `:12790` |
| **记忆 / 侧车** | polar-api、memory-extractor 等读**发行版内**配置与数据目录 |
| **依赖** | `engine/vendor/`、`workflow/`、`polar/` 均为实体复制；`verify-release` 已禁止残留 `workflows/` 外链目录 |
| **密钥** | 遵循 §2.4「保险库运行时注入」；`.env` 仅非敏感配置；敏感项明文唯一存放于**同机** PolarPrivate |

### 2.4 L3 密钥管理：保险库运行时注入（2026-07-12）

> **定位**：L3 独立 Web 项目的密钥管理标准。同机 PolarPrivate 保险库实例是 **Server 标配基础设施**；L3 依赖**同机**保险库**不算脐带**——§2.1 禁令针对的是**回连开发机**（`:12790`、`~/Polarisor/...` 等）。

#### 三条规则

| # | 规则 | 说明 |
|---|------|------|
| **R1** | **明文唯一存放处 = 同机 PolarPrivate** | 加密库，经 GUI（`:12805`）录入；部署包 `.env` / `.env.example` 只放非敏感配置；`*_API_KEY`、`*_PASSWORD`、`SECRET` 等敏感项**一律留空** |
| **R2** | **HTTP 协议密钥 → 无 key 代理路由** | LLM API Key 等走 PolarPrivate `/proxy/{binding}?project_id=...`；key 在代理层注入，业务侧 `.env` 只配置代理 URL（如 `POLARFLOW_LLM_BASE_URL=http://127.0.0.1:12800/proxy/llm.glm52?project_id=…`），`*_API_KEY` 留空 |
| **R3** | **非 HTTP 协议密钥 → 启动脚本内存注入** | SMTP 授权码等：启动脚本从同机保险库解密 → `export` 进进程环境 → **不落盘、不回显**；顺序：**先 `source .env`（非敏感项）→ 再 `export` 敏感值**，防止 `.env` 空值覆盖已注入凭据 |

#### 与脐带禁令的边界

| 场景 | 判定 |
|------|------|
| L3 连 **同机** PolarPrivate `:12800` / `:12805` | ✅ 标配基础设施，非脐带 |
| L3 连 **开发机** PolarPrivate `:12790` | ❌ 违反 B4 |
| 密钥明文写入 L3 `.env` 并提交/交付 | ❌ 违反 R1；发布门禁 §3.6 拦截 |
| 启动脚本从同机保险库注入 SMTP 到内存 | ✅ R3 标准做法 |

#### 参考实现（Server/TaoCi）

| 组件 | 路径 / 说明 |
|------|-------------|
| 统一启动 | `Start/start-taoci.sh` — 检查 PolarPrivate → 解锁 → R3 注入 `EMAIL_*` → 启动引擎 / polar-api / Docker |
| HTTP 代理 | PolarPrivate `:12800`，binding 如 `llm.glm52`；migration 015 补 `proxy_usage` 表 |
| 保险库 GUI | `:12805` — SMTP 条目 `secret.smtp.email_account`、`secret.smtp.auth_code`；LLM 条目 `secret.glm52.api_key` |

---

## 3. 导出包自包含检查清单（发布门禁）

在 L3 目录 promoted 之后、对外交付或上线前，执行以下检查。**全部通过**方可视为符合本规范。

### 3.1 结构与前序门禁

- [ ] `node scripts/export-release.mjs --workflow <id> --compile-only` 成功（或完整 export 成功）
- [ ] `verify-release.mjs` 通过（`site.manifest.json`、`workflow/snapshot.json`、checksum、executors 非空）
- [ ] 存在 `.env.example` 且列出 LLM、JWT、DB、引擎端口等**全部**必填项

### 3.2 无符号链接脐带

```bash
RELEASE_ROOT=~/Desktop/Web_related/{release_id}   # 或目标机实际路径

# 应无输出；若有，逐条确认 target 是否在 RELEASE_ROOT 内部
find "$RELEASE_ROOT" -type l -ls

# 可选：拒绝指向仓库外的 symlink
find "$RELEASE_ROOT" -type l ! -exec test -e {} \; -print
```

### 3.3 无开发机端口引用

```bash
# 命中行须为 0，或仅出现在文档/注释且明确标注「L2 开发示例，禁止用于 L3」
rg -n '8120|8125|12790|11050|11055|5170|3065' "$RELEASE_ROOT" \
  --glob '!*.md' --glob '!EXPORT.log*' --glob '!node_modules/**'
```

可按部署拓扑扩展端口表（如内置引擎 `:8065` 应为**本包申领端口**，而非写死开发机值）。

### 3.4 无开发机绝对路径

```bash
rg -n '~/Polarisor|~/Polarisor' "$RELEASE_ROOT" \
  --glob '!*.md' --glob '!EXPORT.log*'
```

### 3.5 引擎与 LLM 自包含抽检

- [ ] `engine/vendor/polarflow`（若存在）为**目录实体**，`ls -la` 显示非 symlink
- [ ] `site.config.json` / `http_workflows[]` 的 `url` 指向本部署可达地址（非开发机 `:8120`）
- [ ] polar 侧车 / memory-extractor 环境变量指向本机 LLM 或发行版 `.env`，非 `:12790`
- [ ] 在**目标机**（非开发机）启动后，断网开发机或停掉 PolarFlow/PolarPrivate，L3 仍可完成一轮对话

### 3.6 无明文密钥（保险库模式门禁）

`.env` / `.env.example` 中不得出现**非空**敏感值。命中须清零或改为占位符后再交付。

```bash
# 应无输出（或仅注释行）；非空 *_API_KEY / *_PASSWORD / 含 SECRET 的赋值行 = 违规
rg -n '(^|[^#].*)(_API_KEY|_PASSWORD|SECRET)\s*=\s*[^#\s][^\s#]*' \
  "$RELEASE_ROOT/.env" "$RELEASE_ROOT/.env.example" 2>/dev/null || true

# 更严：任意 .env* 模板
rg -n '(^|[^#].*)(_API_KEY|_PASSWORD)\s*=\s*\S+' \
  "$RELEASE_ROOT" --glob '.env*' --glob '!.env' 2>/dev/null || true
```

- [ ] `POLARFLOW_LLM_API_KEY`、`POLAR_LLM_API_KEY`、`EMAIL_PASSWORD` 等为空或仅占位
- [ ] LLM 配置为同机代理 URL（`:12800/proxy/...`），非开发机 `:12790`
- [ ] 非 HTTP 密钥（SMTP 等）由启动脚本从同机保险库注入，文档已说明

### 3.7 记录

将检查结果写入 `EXPORT.log` 末尾或运维笔记；CI 未来可机器读（见 §5）。

---

## 4. 反例：套辞助手独立部署（2026-07-12）

**场景**：从 PolarUI 导出套辞 workflow 独立 Web 包（LibreChat 壳 + polar 侧车 + workflow），部署到 `~/Desktop/Server/TaoCi`。

**期望**：L3 在 Server 上自包含运行。  
**实际**：发现三条脐带，均违反 §2.1。

| 脐带 | 现象 | 根因 | 修复 |
|------|------|------|------|
| **① workflow → 开发机 PolarFlow** | LLM 节点仍将请求转发到开发机共享 PolarFlow `:8120` | L2 联调 URL 渗入 L3 配置 / 未内置引擎 | 改为内置引擎（本包 `:8065`）或目标机自有 `/run`；`http_workflows[].url` 改写 |
| **② polar 侧车 → 开发机 PolarPrivate** | `memory-extractor` 默认连接 `127.0.0.1:12790` | 侧车默认走开发机 Vault/LLM 代理 | 改为**同机** PolarPrivate `:12800/proxy/...`（§2.4 R2）；SMTP 走 `Start/start-taoci.sh`（§2.4 R3） |
| **③ vendor symlink** | `engine/vendor/polarflow` 曾为 symlink → `~/Polarisor/PolarFlow` 源码 | 导出/scaffold 为省空间做了外链 | 改为 **真复制** vendor 树；`find -type l` 门禁 |

**教训**：

1. L2 能跑 ≠ L3 合格；export 必须**切断**所有开发机假设。
2. `verify-release` 通过只保证目录结构与 checksum，**不**保证无端口/路径脐带——须加 §3 人工或自动门禁。
3. 搬迁测试应在**停掉开发机生态服务**后做一次冒烟。

---

## 5. 导出脚本自动门禁（已实现 2026-07-12）

`export-release.mjs` 在 **Step 10 `verifyRelease` 之后、promote 之前** 调用 `scripts/verify-orthogonality.mjs` 的 `verifyOrthogonality(stagingRoot)`；失败则 `stage: 'orthogonality'` 报错并清理 staging（与 `verifyRelease` 相同原子语义）。

### 5.1 建议挂载点

```
export-release.mjs
  …
  Step 10  verifyRelease()           # 已有：结构 + JSON + checksum
  Step 10b verifyOrthogonality()     # 建议新增：正交性脐带扫描
  Promote staging → release/
```

也可在 `scripts/verify-release.mjs` 末尾合并，或独立 `scripts/verify-orthogonality.mjs` 供 CLI/CI 单独调用。

### 5.2 建议检查命令（与 §3 一致）

```bash
# 1. 符号链接
find "$STAGING_ROOT" -type l | while read -r link; do
  target=$(readlink "$link")
  case "$target" in /*) echo "FORBIDDEN_ABSOLUTE_SYMLINK: $link -> $target" ;; esac
done

# 2. 开发机端口（可按生态维护 denylist）
rg -l '8120|8125|12790|11050|11055|5170' "$STAGING_ROOT" \
  --glob '!*.md' --glob '!EXPORT.log*' --glob '!node_modules/**' && exit 1

# 3. 开发机仓库路径
rg -l '~/Polarisor|~/Polarisor' "$STAGING_ROOT" \
  --glob '!*.md' --glob '!EXPORT.log*' && exit 1

# 4. .env.example 存在
test -f "$STAGING_ROOT/.env.example" || test -f "$STAGING_ROOT/polar/.env.example"
```

### 5.3 测试与验收衔接

- 在 `scripts/export-release.test.mjs` 增加 **AC-R06 正交性**：故意含 `:8120` 的 staging fixture 必须被拒绝。
- 与 [`WEB_ACCEPTANCE.md`](./WEB_ACCEPTANCE.md) AC-R04（禁止 `workflows/` 外链）并列，形成「结构冻结 + 运行时正交」双门禁。

---

## 6. 文档落点与生态索引

| 位置 | 角色 |
|------|------|
| **本文** `PolarUI/docs/DEPLOYMENT_SPEC.md` | **主规范（SSoT）** — 三层定义、铁律、门禁、反例 |
| [`PolarUI/docs/WEB_EXPORT.md`](./WEB_EXPORT.md) | 导出流水线步骤；引用本文 §2–§3 |
| [`PolarUI/docs/ARCHITECTURE.md`](./ARCHITECTURE.md) | 架构两阶段；引用本文三层模型 |
| [`PolarFlow/README.md`](../../PolarFlow/README.md) § 部署 | 一行引用本文（PolarFlow 侧不维护副本） |
| [`PolarFlow/docs/DESIGN.md`](../../PolarFlow/docs/DESIGN.md) § M4 | 发行版/外置 HTTP 设计；引用本文正交铁律 |
| `Agent_core/principles/SSOT-DOCS.md` | 生态级文档结构规范；**不**替代项目内部署细则 |

**PolarFlow 开发者注意**：L1 开发时 `:8120` 合法；一旦 flow 进入 PolarUI `export-release` 或 PolarFlow legacy `export-web` 产出 L3，必须满足本文 §2–§3。ADR-012 外置 HTTP 接入时，URL 须指向**部署拓扑内**服务，而非开发机共享 PolarFlow。

---

## 7. 修订记录

| 日期 | 变更 |
|------|------|
| 2026-07-12 | 初版：生态所有者裁定三层正交铁律；套辞 Server/TaoCi 反例；导出自动门禁建议 |
| 2026-07-12 | §2.4 保险库运行时注入（R1–R3）；同机 PolarPrivate 与开发机脐带边界；§3.6 明文密钥 rg 门禁；TaoCi 参考实现 |
