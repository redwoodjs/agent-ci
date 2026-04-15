---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Fix `actions/setup-node` emitting "Bad credentials" and falling back to a slow nodejs.org download. The bundled `@actions/tool-cache` hardcodes `api.github.com` for its versions-manifest fetch; the DTU now rewrites the URL in setup-node's tarball at cache time and mocks the `/repos/:owner/:repo/git/trees|blobs` endpoints so the manifest call routes through the DTU (fixes #249).

Also: when a step fails with `tar: ...: Cannot open: Permission denied` (typically from a stale `/opt/hostedtoolcache` bind mount left by a previous run), surface an actionable hint showing the host-side toolcache path and an `rm -rf` command to clear it (fixes #171).
