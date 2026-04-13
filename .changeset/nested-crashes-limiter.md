---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix nested agent-ci crashes and add global concurrency limiter.

- Skip orphan cleanup when running inside a container (`.dockerenv` detection) to prevent nested agent-ci from killing its own parent container.
- Resolve DTU host from the container's own IP when nested, instead of inheriting the unreachable `AGENT_CI_DTU_HOST`.
- Add a shared concurrency limiter across all workflows in `--all` mode, auto-detected from Docker VM memory (`floor(availableMemory / 4GB)`), to prevent OOM kills (exit 137).
