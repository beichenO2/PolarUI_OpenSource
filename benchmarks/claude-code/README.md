# Claude Code 对照实验数据

PolarUI 与 Claude Code 对照实验（2026-06-02）的冻结结果。

## 目录说明

| 路径 | 内容 |
|------|------|
| `baseline/` | 真实 `@anthropic-ai/claude-code` CLI（经 PolarPrivate 代理，GLM-5.1） |
| `polarui/` | PolarUI `claude-code-lg` 工作流（经 `run-workflow-chat-once.mjs`） |
| `README.md` | 本文件 |

## 基线实验环境（monorepo 语境）

- 工作目录：Polarisor monorepo 根目录（`PolarUI/` 为子目录）
- 代理：`Reference/ClaudeCode/scripts/anthropic-proxy-shim.mjs` → 端口 12791
- LLM：`http://127.0.0.1:12790/v1/chat/completions`，模型码 `100`

## 重跑 PolarUI 侧（本仓库）

```bash
npx tsx scripts/run-claude-code-parity.mjs
```

需要支持 **tools / function calling** 的 OpenAI 兼容 LLM 网关。

## 汇总

**4/4 通过** — 详见 `polarui/polarui-lg-summary.json` 与根目录 [README.md](../../README.md) 中「有效性论述」一节。
