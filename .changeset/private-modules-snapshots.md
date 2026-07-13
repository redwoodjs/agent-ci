---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Closes #378. Give every job private writable `node_modules`, keep npm installs private while sharing npm's download cache, and atomically publish completed pnpm, Yarn, and Bun dependency trees as lockfile-keyed snapshots that are copied into each job with copy-on-write when available.
