---
name: taoci-outreach-workflow
description: >
  套辞助手 workflow：PolarUI 状态机 + Claude Code core + 飞书。
  触发：套辞 workflow、taoci-outreach、导师套辞。
---

# 套辞助手

路径: `PolarUI/workflows/taoci-outreach/`

```bash
node workflows/taoci-outreach/harness/index.mjs \
  --conversation-id ID --message "..." [--files a.pdf]
```

规格: `WORKFLOW.spec.md`
