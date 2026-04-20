---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

Forward `jobs.<id>.container.options` through to the runner container. Previously the options string was parsed but never handed to `docker.createContainer`, so `options: --env FOO=bar` silently produced a container without `FOO`. Now `--env`/`-e` and `--label`/`-l` flags inside `options:` are extracted and merged into the container's `Env` and `Labels`. Other Docker flags in `options:` (`--privileged`, `--user`, `--network`, `--cap-add`, `--workdir`, …) remain intentionally ignored — they clash with agent-ci's own container orchestration and can break the runner's invariants.

`actions/cache` and `GITHUB_TOKEN` compatibility notes updated to document existing limitations (no ref-based cache scoping; no OIDC id-token issuance) so the behaviour matches the documentation.

Refs #296.
