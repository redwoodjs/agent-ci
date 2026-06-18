---
"@redwoodjs/agent-ci": patch
---

Closes #370. Add `agent-ci run --prewarm-through <workflow:job:step-id>` and `AGENT_CI_PREWARM_THROUGH` so a disposable job can warm shared `node_modules` through an explicit workflow step before parallel jobs begin. Agent CI now warns with an actionable prewarm command when cold parallel install jobs look likely, including a structured `diagnostic` event in `--json` mode.
