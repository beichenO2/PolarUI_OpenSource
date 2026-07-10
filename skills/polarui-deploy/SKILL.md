# PolarUI — 部署索引

> 本 skill 为**入口索引**。PolarUI 有两类「部署」，勿混淆。

## 🔷 本地编辑器（画布 dev）

启动 PolarUI GUI，编辑 workflow 图：

→ [`polarui-usage/SKILL.md`](../polarui-usage/SKILL.md)

```bash
cd ~/Polarisor/PolarUI
npm ci && npm run dev -- --port 5170
```

## 🔶 Web 发行版（LibreChat + polar-api）

把 workflow 编译部署为独立网站：

→ [`polarui-web-deploy/SKILL.md`](../polarui-web-deploy/SKILL.md)  
→ [`docs/WEB_EXPORT.md`](../../docs/WEB_EXPORT.md)

```bash
node scripts/export-release.mjs --workflow <id> --json
```

## 相关 Skills

| Skill | 用途 |
|-------|------|
| [`polarui-workflow-contract`](../polarui-workflow-contract/SKILL.md) | Web 运行时契约（builtin / graph-cli） |
| [`polarui-workflow-authoring`](../polarui-workflow-authoring/SKILL.md) | 画布撰写七步流程 |
| [`polarui-troubleshoot`](../polarui-troubleshoot/SKILL.md) | 本地 dev 故障排查 |
