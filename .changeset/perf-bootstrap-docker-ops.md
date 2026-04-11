---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

perf: hoist docker cleanup and image prefetch to session bootstrap

`agent-ci run --all` now runs global Docker cleanup (prune orphans, kill
stale containers, prune stale workspaces) and runner image prefetch exactly
once per session instead of once per workflow. Also dedupes concurrent
`ensureImagePulled` calls so parallel workflows share a single in-flight
`docker pull`. Eliminates cold-start thundering herd and the N× `docker
volume prune` storm that was serializing multi-workflow runs. See #211.
