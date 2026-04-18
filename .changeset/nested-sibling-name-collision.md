---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

fix(runner): nested agent-ci sibling containers collide on `agent-ci-1` when multiple outer runs execute in parallel. Each nested run has its own filesystem so it always allocated `agent-ci-1`, and the pre-spawn `docker rm -f` then killed a sibling belonging to a concurrent nested run. Include the outer container's hostname in the prefix when `/.dockerenv` is present so sibling names stay unique across nested runs. Fixes `smoke-bun-setup.yml` + `smoke-docker-buildx.yml` failing when run together via `agent-ci-dev run --all`.
