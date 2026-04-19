---
"@redwoodjs/agent-ci": minor
"dtu-github-actions": patch
---

Add opt-in smolvm backend for per-job VM isolation on Linux jobs. Set
`AGENT_CI_BACKEND=smolvm` to route Linux jobs through [smolvm](https://github.com/smol-machines/smolvm)
micro-VMs (Hypervisor.framework on macOS, KVM on Linux) instead of the
shared-kernel Docker daemon. Falls back to Docker if smolvm is missing or the
host is unsupported. Refs #284.
