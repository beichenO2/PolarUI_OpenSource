---
name: polarui-deploy
description: Use when deciding between the local PolarUI GUI preview and exporting a workflow as an independently governed Web release.
---

# PolarUI deployment index

## Local GUI preview

Use `polarui-usage`. The stable GUI is `polarui:5170`; PolarPort owns allocation and PolarProcess owns start, stop, restart, PID, and health supervision.

```bash
curl -fsS http://127.0.0.1:11055/api/services/polarui
```

## Exported Web release

Use `polarui-web-deploy` and `docs/WEB_EXPORT.md`. Export compilation is a transient command; the resulting persistent service must claim its host port through PolarPort and register/start through PolarProcess.

```bash
node scripts/export-release.mjs --workflow <id> --json
```

The export/deploy pipeline must use `http://127.0.0.1:11050` and `http://127.0.0.1:11055`. It must not use detached containers, direct Vite/Node server startup, PID files, broad process matching, or another process manager.

Native Web preview and `polarui-native-web-qa-*` are separate service boundaries. Never restart or release them while operating the stable GUI.
