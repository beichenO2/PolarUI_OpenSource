---
name: polarui-troubleshoot
description: Use when the PolarUI GUI, Native Web preview, or a governed PolarUI QA service is unavailable, unhealthy, or bound to an unexpected port.
---

# PolarUI troubleshooting

## Read-only diagnosis

```bash
curl -fsS http://127.0.0.1:11050/api/health
curl -fsS http://127.0.0.1:11055/api/health
curl -fsS http://127.0.0.1:11055/api/services/polarui
curl -fsS http://127.0.0.1:11050/api/list
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5170/
```

Use PolarProcess's verified PID and PolarPort's exact `service_name/project/port` owner. Do not infer ownership from a broad process-name search.

## Exact recovery

After both authorities pass health checks, act only on the failing service ID:

```bash
curl -fsS -X POST http://127.0.0.1:11055/api/services/polarui/restart
```

The stable GUI (`polarui`), Native Web preview (`polarui-native-web-preview`), QA services, brainstorm previews, and exported Web releases are separate boundaries. Never restart one to repair another.

## Prohibited shortcuts

Do not start Vite/Node/Docker directly for a persistent listener. Do not use detached containers, background shell jobs, PID files, direct signals, launchd, or manual release of another service's port.
