---
name: polarui-usage
description: Use when opening, inspecting, restarting, or developing against the stable PolarUI GUI preview on the local Polarisor machine.
---

# PolarUI GUI usage

## Runtime authority

PolarPort is the only port authority and PolarProcess is the only lifecycle authority. The stable GUI service ID is `polarui`, with preferred port 5170 and health endpoint `http://127.0.0.1:5170/`.

Install and build are transient commands. Persistent preview actions must use the exact PolarProcess service ID:

```bash
curl -fsS http://127.0.0.1:11050/api/health
curl -fsS http://127.0.0.1:11055/api/services/polarui
curl -fsS -X POST http://127.0.0.1:11055/api/services/polarui/restart
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5170/
```

Do not start Vite directly, use background shell jobs, maintain PID files, send direct signals, or invoke launchd. Do not treat Native Web preview or QA service IDs as aliases for the stable GUI.

## Workflow navigation

Open `http://127.0.0.1:5170/`. Load a graph from the Workflow panel or open its JSON directly; LG/WF are graph features rather than separate modes.

| Stage | Skill / document |
|---|---|
| Canvas editing | `polarui-workflow-authoring` |
| Web runtime contract | `polarui-workflow-contract` |
| Exported Web deployment | `polarui-web-deploy` |
| Architecture | `docs/ARCHITECTURE.md` |

Optional dependencies include PolarCopilot Hub for online SSoT and PolarPrivate for LLM access. Inspect their own PolarProcess records; never start them as a side effect of opening PolarUI.
