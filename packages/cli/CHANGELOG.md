# @redwoodjs/agent-ci

## 0.14.0

### Minor Changes

- 44595b1: Surface degraded local runs when the host machine is smaller than the runner spec declared by `runs-on:` (e.g. `ubuntu-latest-8-cores`). The job is tagged `degraded`, a warning is printed before execution, and `[degraded]` appears in CLI output. Execution is never blocked — slow runs and OOMs now have a visible cause instead of being a mystery.

  Refs #229.

- 76b46f9: Revert the opt-in smolvm backend (#287). The implementation proved too rough
  to keep in-tree while iterating — it will return once the boot path is
  reliable on the current smolvm release. `AGENT_CI_BACKEND=smolvm` is no
  longer recognized; Linux jobs always run through Docker.

### Patch Changes

- 6a26cae: Add support for expansion of variables in the `env` context in expressions.

  `env` context variables deriving from the merged step environment (workflow-level + job-level + step-level `env:`) are now expanded in expressions, matching GitHub Actions behavior. Previously these references resolved to empty strings.

- Updated dependencies [44595b1]
- Updated dependencies [76b46f9]
- Updated dependencies [6a26cae]
  - dtu-github-actions@0.14.0

## 0.13.0

### Minor Changes

- 77ea148: Rename `DOCKER_HOST` to `AGENT_CI_DOCKER_HOST` and load `AGENT_CI_*` vars from `.env.agent-ci`.

  **Breaking:** agent-ci no longer honours the standard `DOCKER_HOST` env var. If it is set in the shell, agent-ci exits immediately with an error asking you to rename it. Rename it in your shell (or move it to `.env.agent-ci`) as `AGENT_CI_DOCKER_HOST`. This avoids the long-standing collision where users wanted agent-ci to target one daemon (e.g. a Lima/OrbStack VM) while their shell's `docker` CLI targeted another.

  **New:** `AGENT_CI_*`-prefixed keys in `.env.agent-ci` are now loaded into the CLI process environment at startup, so Docker/network configuration (e.g. `AGENT_CI_DOCKER_HOST`, `AGENT_CI_DTU_HOST`, `AGENT_CI_DOCKER_EXTRA_HOSTS`) no longer has to be exported in the shell. Shell env vars still take precedence over `.env.agent-ci`. Non-prefixed keys in the file remain workflow secrets (`${{ secrets.FOO }}`) as before.

  Refs #308.

- 3212927: Persist the latest run result per worktree to `$AGENT_CI_STATE_DIR` (or OS-default state dir) as JSON, so external consumers (tmux panes, status bars, editor integrations) can read the current branch's CI status without re-running the tool or scraping human output.

  The file is written atomically after every `agent-ci run` / `agent-ci run --all` and keyed by `<branch>.<worktree-hash>.json` under `<org>/<repo>/`, so two worktrees on the same branch don't stomp each other. Each job entry carries the full step list with per-step `logPath`, plus `debugLogPath` for the whole job. Paths are only included when the file still exists at write time. Includes `headSha` so consumers can detect stale results themselves.

  Refs #288

### Patch Changes

- f5f7dbd: Fix: honor step-level `if:` conditions. Previously every step ran regardless of its `if:` clause, because `parseWorkflowSteps` never extracted `step.if` from the workflow, and the server fell back to `condition: "success()"` for every step. Now the condition is forwarded to the runner's EvaluateStepIf, so gates like `if: contains(runner.name, 'blacksmith')`, `if: always()`, and `if: ${{ false }}` behave as they do on real GitHub Actions.
- Updated dependencies [77ea148]
- Updated dependencies [f5f7dbd]
- Updated dependencies [3212927]
  - dtu-github-actions@0.13.0

## 0.12.4

### Patch Changes

- e2fe576: Make `packages/cli/compatibility.json` the single source of truth for the YAML compatibility matrix. The `compatibility.md` document and the website's compatibility table are both derived from it — run `pnpm compat:gen` after editing the JSON. `pnpm check` fails if the `.md` drifts out of sync.
- e2fe576: Add a `proof` field to `compatibility.json` rows pointing at the workflow files that exercise each feature end-to-end. Internal field — not rendered in the markdown table or on the website. The `compat:gen` script fails if any listed proof path does not resolve on disk, so a file rename can't silently break a compatibility claim.

  Refs #292.

- 044de23: Forward `jobs.<id>.container.options` through to the runner container. Previously the options string was parsed but never handed to `docker.createContainer`, so `options: --env FOO=bar` silently produced a container without `FOO`. Now `--env`/`-e` and `--label`/`-l` flags inside `options:` are extracted and merged into the container's `Env` and `Labels`. Other Docker flags in `options:` (`--privileged`, `--user`, `--network`, `--cap-add`, `--workdir`, …) remain intentionally ignored — they clash with agent-ci's own container orchestration and can break the runner's invariants.

  `actions/cache` and `GITHUB_TOKEN` compatibility notes updated to document existing limitations (no ref-based cache scoping; no OIDC id-token issuance) so the behaviour matches the documentation.

  Refs #296.

- e2fe576: Propagate `defaults.run.working-directory` to steps. Workflow-level and job-level `defaults.run.working-directory` were parsed but never applied — every step ran at the workspace root regardless of the declared default. Now merged with standard GitHub Actions precedence: step override beats job default beats workflow default.

  Refs #290.

- f44620b: Let `hashFiles()` descend into dotted directories. The recursive walker was skipping any directory whose name starts with `.`, which meant patterns like `hashFiles('.github/workflows/*.yml')` never matched a file and returned the zero-placeholder (`"000…"`, 40 chars). Now only `node_modules` is skipped; dotted directories are walked when a pattern asks for them. The resulting digest is real SHA-256 (64 chars), matching GitHub Actions.

  Refs #294.

- 5a23a5a: Flesh out `compatibility.json` with 15 rows that were absent before — features real GitHub Actions documents but our table said nothing about. Status is chosen per code inspection, so each row reflects current behaviour rather than aspirational coverage:
  - **Workflow triggers**: sub-event filters `branches`/`branches-ignore` (supported), `paths`/`paths-ignore` (supported), `tags`/`tags-ignore` (unsupported), `types` (ignored), `workflow_dispatch.inputs` (ignored — dispatch itself isn't simulated), `workflow_call.inputs.*` (supported), `workflow_call.outputs.*.value` (supported).
  - **Job-level**: `jobs.<id>.permissions` (ignored), `jobs.<id>.container.credentials` (unsupported), `jobs.<id>.services.*.credentials` (unsupported).
  - **Step-level**: `steps[*].uses: docker://…` (unsupported — Docker-image action refs are not resolved).
  - **Expressions**: `vars.*` (supported), `inputs.*` (supported), `steps.*.conclusion` / `steps.*.outcome` (unsupported), `job.*` runtime context (unsupported), `*` object-filter operator (unsupported).

  No behaviour changes — just honest documentation. Closes the "missing rows" bucket on #296.

- fdec27e: Split the remaining overloaded rows in `compatibility.json` so each documented feature has a row that reflects its real status. Pure documentation — no behaviour changes.
  - **`github.*`** — split into three rows: `github.sha` (real from git), `github.repository` / `github.repository_owner` (derived from the remote), and a catch-all row documenting that everything else resolves to a static default or an empty string. The catch-all enumerates the rest of the context so a reader can tell `workflow_sha`, `triggering_actor`, etc. are not populated.
  - **`runner.*`** — added a row for the unsupported siblings (`runner.name`, `runner.temp`, `runner.tool_cache`, `runner.debug`, `runner.environment`) so it's visible that only `runner.os` / `runner.arch` resolve.
  - **`contains` / `startsWith` / `endsWith`** — three separate rows with per-function notes.
  - **`success()` / `failure()` / `always()` / `cancelled()`** — downgraded to `partial` with a note clarifying that `cancelled()` always returns `false` locally (no cancellation signal).
  - **`on` (other events)** — kept as one row but the note now enumerates the ~20 event names it covers so users can see exactly which triggers are no-ops.

  Closes the "overloaded row" bucket on #296.

- 78e3e01: Honor `defaults.run.shell` and step-level `shell:` for non-bash shells. The runner executes every `run:` step with bash regardless of `inputs.shell`, so the parser now wraps scripts that request `sh`, `python`, or `pwsh` with an explicit invocation of the requested interpreter (`sh -e <<'EOF' … EOF`). Workflow, job, and step scopes all use standard step-wins-over-job-wins-over-workflow precedence.

  Refs #293.

- e2fe576: Stop step-level `env:` from leaking into sibling steps. Each step's env now attaches as its own `environment` on the mapped step rather than being merged into the job-wide `EnvironmentVariables` map, where a later step's values could override an earlier step's reads of the same key.
- f44620b: Stop leaking literal `${{ steps.<id>.outputs.<name> }}` text into `run:` scripts. The parser used to leave these expressions untouched on the premise that the runner would evaluate them at runtime, but the runner does not re-evaluate expressions inside run-script bodies — the literal `${{ }}` reached bash and produced "bad substitution" errors. The expression now resolves to an empty string at parse time, matching the long-standing documented behavior.

  Use `needs.*.outputs.*` for cross-job values — those are resolved against real job outputs.

  Refs #295.

- ab410c7: Two small expression-engine fixes surfaced while running through #296's "questionable claim" rows:
  1. **`toJSON` now pretty-prints with 2-space indent** to match GitHub Actions. Previously emitted compact JSON, which meant that any `hashFiles` key that consumed `toJSON(x)` would hash to a different digest locally vs. on GitHub. Parses `rawValue` before re-serialising so `toJSON(fromJSON(x))` round-trips.
  2. **`''`, `null`, and numeric strings now coerce in comparisons** per the spec: `'' == 0`, `null == 0`, `'0' == 0` are all `true`; `'x' == 0` stays `false` because non-numeric strings become `NaN`. Previously, empty/null on either side fell out of the numeric path and was string-compared, so `'' == 0` resolved to `false`.

  Refs #296.

- Updated dependencies [e2fe576]
- Updated dependencies [e2fe576]
- Updated dependencies [044de23]
- Updated dependencies [e2fe576]
- Updated dependencies [f44620b]
- Updated dependencies [5a23a5a]
- Updated dependencies [fdec27e]
- Updated dependencies [78e3e01]
- Updated dependencies [e2fe576]
- Updated dependencies [f44620b]
- Updated dependencies [ab410c7]
  - dtu-github-actions@0.12.4

## 0.12.3

### Patch Changes

- 2e7c844: Document and surface Docker Desktop's default-socket toggle. Docker Desktop 4.x ships with `/var/run/docker.sock` disabled, so a fresh install will hit `agent-ci couldn't use a Docker socket at /var/run/docker.sock` even when Docker Desktop is running. The `docker-socket.md` recipe now walks through the Settings → Advanced toggle, and the resolver error appends a one-shot hint pointing at it whenever it detects Docker Desktop's user-side socket (`~/.docker/run/docker.sock`).

  Refs #253.

- Updated dependencies [2e7c844]
  - dtu-github-actions@0.12.3

## 0.12.2

### Patch Changes

- e320288: fix(runner): nested agent-ci sibling containers collide on `agent-ci-1` when multiple outer runs execute in parallel. Each nested run has its own filesystem so it always allocated `agent-ci-1`, and the pre-spawn `docker rm -f` then killed a sibling belonging to a concurrent nested run. Include the outer container's hostname in the prefix when `/.dockerenv` is present so sibling names stay unique across nested runs. Fixes `smoke-bun-setup.yml` + `smoke-docker-buildx.yml` failing when run together via `agent-ci-dev run --all`.
- 3f1c836: fix(workflow): expand `${{ runner.os }}` / `${{ runner.arch }}` from the job's `runs-on:` label instead of hardcoding Linux/X64. macOS jobs (e.g. `runs-on: macos-14`) now expand to `macOS`/`ARM64`, matching GitHub-hosted runner behavior and making conditionals like `if: runner.os == 'macOS'` work under tart-backed VM execution (#279).
- Updated dependencies [e320288]
- Updated dependencies [3f1c836]
  - dtu-github-actions@0.12.2

## 0.12.1

### Patch Changes

- 59d6c40: Fix `UnauthorizedAccessException` on `/home/runner/_diag` and workspace write failures when running on macOS with Colima or Docker Desktop (#263).

  On those Docker backends the bind-mounted `_diag` and `_work` directories surface as `root:root 0755` inside the container because host permissions don't translate through the VM mount layer. The runner user (uid 1001) then can't write its diag logs or scratch files and the job crashes on startup. We now `MAYBE_SUDO chmod 1777` both mount points during container boot, mirroring the existing fix for `/home/runner/.cache` (#234). OrbStack and native Linux Docker are unaffected — the chmod is a no-op there.

  Also hardens Docker socket detection: agent-ci now requires a working socket at `/var/run/docker.sock` (unless `DOCKER_HOST` is set explicitly) and fails fast with a link to a new per-provider setup guide (`packages/cli/docs/docker-socket.md`) instead of silently picking a provider-specific path that the mount layer later rejects. This eliminates a class of confusing "operation not supported" errors when switching Docker backends (e.g. leftover OrbStack symlinks on a Colima host).

- cbf0c44: Release workflow now closes referenced issues on publish instead of on version-PR merge.

  `pnpm run version` captures `Closes|Fixes|Resolves #N` references from pending changesets into `.release-closes.json`, pairs each with the PR that introduced the changeset, and rewrites the keywords to `Refs #N` in the changeset bodies so the "chore: version packages" PR does not close them on merge. After `changesets/action` publishes, a new step reads `.release-closes.json` and closes each issue with a `Closes Issue #N via PR #M.` comment.

- Updated dependencies [59d6c40]
- Updated dependencies [cbf0c44]
  - dtu-github-actions@0.12.1

## 0.12.0

### Minor Changes

- 12220be: Run `runs-on: macos-*` jobs in a real macOS VM via [tart](https://github.com/cirruslabs/tart) on Apple Silicon hosts.

  When the host is `darwin`/`arm64` with `tart` and `sshpass` installed, jobs whose `runs-on:` targets macOS launch a cirruslabs macOS VM, rsync in the macOS `actions-runner` binary, and connect the runner to the ephemeral DTU via the host bridge. Concurrency is capped at 2 VMs by default (override with `AGENT_CI_MACOS_VM_CONCURRENCY`).

  Hosts that don't support this (Linux, Intel macOS, missing tart/sshpass) continue to skip macOS jobs with the same warning introduced in #273. Windows jobs are still skipped on all hosts.

  Image mapping:
  - `macos-13` → `macos-ventura-xcode:latest`
  - `macos-14` → `macos-sonoma-xcode:latest`
  - `macos-15` → `macos-sequoia-xcode:latest`
  - `macos-26` → `macos-tahoe-xcode:latest`
  - `macos` / `macos-latest` → `macos-sonoma-xcode:latest`
  - Override with `AGENT_CI_MACOS_VM_IMAGE`.

### Patch Changes

- Updated dependencies [12220be]
  - dtu-github-actions@0.12.0

## 0.11.0

### Minor Changes

- 372a47b: Support `env:` at workflow and job level (not just step level).

  Previously the workflow parser only read `env:` declared directly on a step. Workflow-level and job-level `env:` blocks were silently ignored, so any workflow that relied on them — including workflows that referenced `${{ vars.X }}` in a job-level env — saw empty values at runtime.

  The parser now merges `env:` from all three levels per the GitHub Actions spec: workflow → job → step, step-most-specific wins. Expressions (including `${{ vars.X }}`, `${{ secrets.X }}`, etc.) are expanded per-level.

  This also makes the `smoke-vars-preflight.yml` Case 3 assertion actually verify the feature it documents — previously the assertion depended on env leaking in from the outer runner process.

- 9474fb5: Skip jobs with `runs-on: macos-*` or `windows-*` instead of silently running them in a Linux container

  Previously, jobs targeting macOS or Windows runners were silently routed to the Linux runner container and failed at the first OS-specific step (e.g. `Setup Xcode`), producing a confusing error. They now skip with a visible `[Agent CI]` warning that points at the tracking issues for real support. Linux and `self-hosted`-without-OS-hint jobs are unaffected.

  Tracking:
  - https://github.com/redwoodjs/agent-ci/issues/254 (this guardrail)
  - https://github.com/redwoodjs/agent-ci/issues/258 (real macOS runner support)

- 2bb4e57: Add support for `${{ vars.FOO }}` expressions in local workflow runs. Supply vars via the `--var KEY=VALUE` CLI flag (repeat for multiple). Runs fail with a clear error listing the missing vars if any required var is not provided.

### Patch Changes

- b6b9310: fix: docker/setup-buildx-action and other Docker socket users fail with "permission denied" on native Linux Docker (#257)

  The runner container's entrypoint chmods the bind-mounted `/var/run/docker.sock` to `0666` so the `runner` user can talk to the Docker daemon. On native Linux Docker the socket is owned `root:docker`, so the chmod needs `sudo` — but it was using plain `chmod` and silently failing. Steps like `docker/setup-buildx-action@v4`, `docker login`, and `docker compose` then failed with `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock`. Now escalated via `MAYBE_SUDO`, matching the other privileged entrypoint operations.

- 3b16523: Improve error hints when fetching remote reusable workflows from private repositories. GitHub returns HTTP 404 (not 401/403) when authentication is missing or insufficient for a private repo — to avoid leaking repo existence — so the 404 path now emits the same auth guidance as the 401/403 path, including instructions to run `gh auth login` and use `--github-token`. The hint also distinguishes between the no-token case (how to provide one) and the token-provided case (scope / fine-grained permission / SSO authorization may be missing).
- Updated dependencies [b6b9310]
- Updated dependencies [372a47b]
- Updated dependencies [3b16523]
- Updated dependencies [9474fb5]
- Updated dependencies [2bb4e57]
  - dtu-github-actions@0.11.0

## 0.10.7

### Patch Changes

- e482875: Fix `actions/setup-node` emitting "Bad credentials" and falling back to a slow nodejs.org download. The bundled `@actions/tool-cache` hardcodes `api.github.com` for its versions-manifest fetch; the DTU now rewrites the URL in setup-node's tarball at cache time and mocks the `/repos/:owner/:repo/git/trees|blobs` endpoints so the manifest call routes through the DTU (fixes #249).

  Also: when a step fails with `tar: ...: Cannot open: Permission denied` (typically from a stale `/opt/hostedtoolcache` bind mount left by a previous run), surface an actionable hint showing the host-side toolcache path and an `rm -rf` command to clear it (fixes #171).

- 2114d67: fix: permission errors in direct-container mode on Arch Linux
- Updated dependencies [e482875]
  - dtu-github-actions@0.10.7

## 0.10.6

### Patch Changes

- 64d654d: Auto-pull runner image on first run with visible progress output. Previously, first-time users saw a frozen spinner or a confusing "No such image" error because the pull happened silently and failures were only debug-logged.
- Updated dependencies [64d654d]
  - dtu-github-actions@0.10.6

## 0.10.5

### Patch Changes

- 2e2bd5e: fix: always show workflows and jobs in --all mode, fix duplicate matrix jobs
- Updated dependencies [2e2bd5e]
  - dtu-github-actions@0.10.5

## 0.10.4

### Patch Changes

- 25c1c5d: Fix Cypress install failing with EACCES on `/home/runner/.cache/Cypress`.
- Updated dependencies [25c1c5d]
  - dtu-github-actions@0.10.4

## 0.10.4

### Patch Changes

- Fix Cypress install failing with EACCES on `/home/runner/.cache/Cypress` (#234).

## 0.10.3

### Patch Changes

- ca4610f: Fix expression evaluation in workflow parser to support boolean operators (`&&`, `||`, `!`), `format()`, and `toJSON()`.
- Updated dependencies [ca4610f]
  - dtu-github-actions@0.10.3

## 0.10.2

### Patch Changes

- 37d6125: Fix nested agent-ci crashes and add global concurrency limiter.
  - Skip orphan cleanup when running inside a container (`.dockerenv` detection) to prevent nested agent-ci from killing its own parent container.
  - Resolve DTU host from the container's own IP when nested, instead of inheriting the unreachable `AGENT_CI_DTU_HOST`.
  - Add a shared concurrency limiter across all workflows in `--all` mode, auto-detected from Docker VM memory (`floor(availableMemory / 4GB)`), to prevent OOM kills (exit 137).

- Updated dependencies [37d6125]
  - dtu-github-actions@0.10.2

## 0.10.1

### Patch Changes

- 71a3ebb: Exclude test files from published dist by adding tsconfig exclude for `*.test.ts`.
- Updated dependencies [71a3ebb]
  - dtu-github-actions@0.10.1

## 0.10.0

### Minor Changes

- 66ac2a4: Add pluggable runner image via `.github/agent-ci.Dockerfile` convention (#208).

  agent-ci now discovers a user-provided Dockerfile at `.github/agent-ci.Dockerfile` (or `.github/agent-ci/Dockerfile` for builds with a COPY context), hashes its contents, builds it locally via `docker build`, and uses the resulting `agent-ci-runner:<hash>` tag as the default runner image. Edits to the Dockerfile produce a new hash and trigger an automatic rebuild; identical contents reuse the cached image.

  This closes the long-standing gap where the minimal `ghcr.io/actions/actions-runner:latest` image lacks `build-essential`, `python3`, and other toolchains that GitHub's hosted `ubuntu-latest` VM ships preinstalled. Workflows that run green on GitHub but fail locally with `linker 'cc' not found` or similar can now opt into a richer image by dropping a 5-line Dockerfile into `.github/`.

  Resolution order (highest wins):
  1. Per-job `container:` directive (unchanged)
  2. `AGENT_CI_RUNNER_IMAGE` environment variable
  3. `.github/agent-ci/Dockerfile` (directory form, supports COPY)
  4. `.github/agent-ci.Dockerfile` (simple form, empty context)
  5. `ghcr.io/actions/actions-runner:latest` (unchanged default)

  Also adds an error-hint heuristic: when a step fails with a "command not found" pattern for common tools (`cc`, `gcc`, `make`, `python3`, `pkg-config`) and the user is still on the default image, the failure summary includes a ready-to-paste Dockerfile snippet pointing at the fix. See `packages/cli/runner-image.md` for full documentation.

### Patch Changes

- 1c7e663: Fix Docker socket bind mount on Linux + Docker Desktop when user is not in the docker group (#209). `resolveDockerSocket()` now treats `socketPath` (API client) and `bindMountPath` (container mount source) as independent decisions: whenever `/var/run/docker.sock` exists on the host, it is used as the bind-mount source regardless of our process's R/W access. This collapses the macOS Docker Desktop symlink case (#197) and the Linux Docker Desktop non-docker-group case (#209) into one rule.
- 38994c8: Fix service container and runner leak on unclean shutdown.
- 1a92bbd: Fix Docker socket bind-mount failure on macOS Docker Desktop (#197).

  When `/var/run/docker.sock` is a symlink (common with Docker Desktop), the resolved real path was being used as the container bind-mount source. Docker's VM cannot access that host path, causing "error while creating mount source path". Now `resolveDockerSocket()` returns a separate `bindMountPath` (the pre-symlink path, e.g. `/var/run/docker.sock`) for use in bind mounts, while `socketPath` (the resolved path) continues to be used for the Docker API client connection.

- cf18585: perf: hoist docker cleanup and image prefetch to session bootstrap

  `agent-ci run --all` now runs global Docker cleanup (prune orphans, kill
  stale containers, prune stale workspaces) and runner image prefetch exactly
  once per session instead of once per workflow. Also dedupes concurrent
  `ensureImagePulled` calls so parallel workflows share a single in-flight
  `docker pull`. Eliminates cold-start thundering herd and the N× `docker
volume prune` storm that was serializing multi-workflow runs. See #211.

- 38994c8: fix: use XDG cache dir on Linux + Docker Desktop instead of /tmp (#215)
- Updated dependencies [1c7e663]
- Updated dependencies [38994c8]
- Updated dependencies [1a92bbd]
- Updated dependencies [cf18585]
- Updated dependencies [66ac2a4]
- Updated dependencies [38994c8]
  - dtu-github-actions@0.10.0

## 0.9.0

### Minor Changes

- b93ecdf: Compute dirty SHA for uncommitted worktrees so `github.sha` reflects the code actually being executed.
- 2cf4034: Resolve workflow secrets from shell environment variables (fallback to .env.agent-ci file). Also auto-populate `secrets.GITHUB_TOKEN` from `--github-token`.

### Patch Changes

- 1e2714b: Fix "No such image" error on first run for users without a local Docker image cache.
- 9ff0710: Deduplicate identical failure errors in output summary and streaming messages.
- 68b1d14: Show failure output and retry/abort hints for paused jobs in multi-job workflows.
- Updated dependencies [b93ecdf]
- Updated dependencies [2cf4034]
- Updated dependencies [1e2714b]
- Updated dependencies [9ff0710]
- Updated dependencies [68b1d14]
  - dtu-github-actions@0.9.0

## 0.8.2

### Patch Changes

- f7e42f0: Fix signal handler to clean up runner directory on Ctrl+C. Add parent-PID liveness tracking to detect and kill orphaned Docker containers on startup. Wire up pruneStaleWorkspaces to clean up old run directories.
- cd24a04: Fix actions/checkout@v6 compatibility by using the real HEAD SHA instead of a fake placeholder.
- e42f4a9: Fix Docker socket detection on Linux when /var/run/docker.sock exists but is not accessible (EACCES).
- 02741dc: Mount warm node_modules directly at workspace path instead of symlinking via /tmp
- Updated dependencies [f7e42f0]
- Updated dependencies [cd24a04]
- Updated dependencies [e42f4a9]
- Updated dependencies [02741dc]
  - dtu-github-actions@0.8.2

## 0.8.1

### Patch Changes

- 1f24fec: Make GitHub authentication opt-in for remote reusable workflow fetching. Add --github-token CLI flag and AGENT_CI_GITHUB_TOKEN env var.
- Updated dependencies [1f24fec]
  - dtu-github-actions@0.8.1

## 0.8.0

### Minor Changes

- f660c11: Support composite action step outputs and push event context for changed-files actions
- ba84b69: Add ts-runner: a TypeScript replacement for the GitHub Actions runner that executes workflow `run:` steps natively without Docker.
- 6b7a95b: Support local composite actions (`uses: ./.github/actions/...`) by setting `RepositoryType: "self"` so the runner resolves them from the workspace.
- cf31ce1: Support nested reusable workflows up to 4 levels deep, matching GitHub Actions' limit.
- e9c5df5: Support local reusable workflows (`uses: ./.github/workflows/...`) by inlining called jobs into the caller's dependency graph.
- 789e403: Support passing inputs and outputs through reusable workflows. Caller `with:` values are now resolved and available as `inputs.*` in called workflows, input defaults from `on.workflow_call.inputs` are respected, and `on.workflow_call.outputs` are wired back so downstream jobs can consume `needs.<callerJobId>.outputs.*`.

### Patch Changes

- c7d45a2: Use resolved DOCKER_HOST socket path for container bind mount instead of hardcoding /var/run/docker.sock.
- 7a612b0: Fix duplicate error messages on workflow failure by removing the intermediate console.error in handleWorkflow's catch block.
- fbd8dea: Fix horizontal scrolling on code blocks in mobile in-app browsers (e.g. Twitter/X).
- 8fbe36d: Fix TypeScript @types resolution for pnpm projects using warm-modules cache.
- 81aedf3: Fix stderr leak from git commands and support non-origin remote names.
- 912ed83: Preserve git-tracked symlinks in workspace snapshot copies.
- 2820b5a: Remove test script from ts-runner package to unblock release workflow.
- 1b1c664: Guard against undefined template.jobs from workflow parser to prevent TypeError crash.
- ed4e86c: Fix parseWorkflowSteps crash when template.jobs is undefined.
- Updated dependencies [f660c11]
- Updated dependencies [ba84b69]
- Updated dependencies [c7d45a2]
- Updated dependencies [7a612b0]
- Updated dependencies [fbd8dea]
- Updated dependencies [8fbe36d]
- Updated dependencies [81aedf3]
- Updated dependencies [912ed83]
- Updated dependencies [2820b5a]
- Updated dependencies [1b1c664]
- Updated dependencies [6b7a95b]
- Updated dependencies [cf31ce1]
- Updated dependencies [ed4e86c]
- Updated dependencies [e9c5df5]
- Updated dependencies [789e403]
  - dtu-github-actions@0.8.0

## 0.7.1

### Patch Changes

- 17ef340: Fix --all hanging on single-job workflows due to cross-workflow job stealing.

  Pin `job.runnerName = containerName` before the DTU seed call so every job goes to the runner-specific pool. Move container and ephemeral DTU cleanup into a `finally` block to ensure cleanup even on mid-run errors. Set `process.setMaxListeners(0)` to suppress EventEmitter warnings when running many parallel jobs.

- 336fb98: Fix: treat runner that never contacted DTU as a failure instead of success. When `isBooting` is still true after the container exits (meaning no timeline entries were received), the job is now correctly reported as failed regardless of exit code.
- cc73a1f: Fix race condition in concurrent log directory allocation by using atomic mkdirSync.
- be5cacd: Fix handleWorkflow catch block swallowing errors by re-throwing instead of returning empty array
- 5fadfee: Remove stopped agent-ci containers before pruning networks to prevent address pool exhaustion.
- 1e9d7ca: Support `pull_request_target` in workflow relevance check, applying the same branch and paths filter logic as `pull_request`. Fix Docker container name collisions when running multiple workflows concurrently via `--all` by pre-allocating unique run numbers per workflow.
- 73f6bf0: Propagate job-level env into DTU Variables store and add AGENT_CI_LOCAL to Docker container env.
- Updated dependencies [17ef340]
- Updated dependencies [336fb98]
- Updated dependencies [cc73a1f]
- Updated dependencies [be5cacd]
- Updated dependencies [5fadfee]
- Updated dependencies [1e9d7ca]
- Updated dependencies [73f6bf0]
  - dtu-github-actions@0.7.1

## 0.7.0

### Minor Changes

- c2fe31b: Cache action tarballs on first download and serve from disk on subsequent runs, eliminating ~30s GitHub CDN delays. Capture step output via tee to signals dir for reliable pause-on-failure tail display. Fix CLI to treat empty results as failure.
- acb750f: Show Docker image pull progress (bytes downloaded / total) as a sub-step under "Starting runner" during boot.

### Patch Changes

- f9f17fd: Detect project package manager and only mount relevant PM cache directories into the container. Projects using npm, yarn, or bun no longer get unnecessary pnpm store bind mounts (and vice versa). Falls back to mounting all PM caches when no lockfile is detected.
- Updated dependencies [f9f17fd]
- Updated dependencies [c2fe31b]
- Updated dependencies [acb750f]
  - dtu-github-actions@0.7.0

## 0.6.0

### Minor Changes

- 6e53753: Post GitHub commit status via gh CLI after agent-ci run completes

### Patch Changes

- d273b76: Show full per-step log content in failure summary instead of a truncated 20-line tail.
- a987818: Simplify Docker host resolution to be OS-agnostic by default, with explicit environment-variable overrides for custom networking setups.
- Updated dependencies [6e53753]
- Updated dependencies [d273b76]
- Updated dependencies [a987818]
  - dtu-github-actions@0.6.0

## 0.5.0

### Minor Changes

- 179405b: Add package metadata, SKILL.md, and AI agent discoverability section to README

### Patch Changes

- Updated dependencies [179405b]
  - dtu-github-actions@0.5.0

## 0.4.0

### Minor Changes

- 61d3e25: Add --no-matrix flag to collapse matrix workflows into a single job.

### Patch Changes

- Updated dependencies [61d3e25]
  - dtu-github-actions@0.4.0

## 0.3.4

### Patch Changes

- 6ada721: Fix Node 22 crash caused by `@actions/workflow-parser` importing JSON without the required `type: "json"` import attribute. A custom ESM loader hook now transparently adds the missing attribute at runtime. Fixes #67.
  - dtu-github-actions@0.3.4

## 0.3.3

### Patch Changes

- fix(dtu): replace execa with node:child_process to fix production runtime error
- Updated dependencies
  - dtu-github-actions@0.3.3

## 0.3.2

### Patch Changes

- 0d5a027: Fix rejected promise handling in job execution and refactor error handling to use type guards with `taskName` attached to errors.
- Fix `npx @redwoodjs/agent-ci` failing with "import: command not found" by adding the missing `#!/usr/bin/env node` shebang to the CLI entry point.
  - dtu-github-actions@0.3.2

## 0.3.1

### Patch Changes

- 6e0ace7: Fix rejected promise handling in job execution and refactor error handling to use type guards with `taskName` attached to errors.
  - dtu-github-actions@0.3.1

## 0.3.0

### Minor Changes

- 8510ce1: Add workflow compatibility features: cross-job outputs, job-level `if` conditions, `fromJSON()`/`toJSON()`, and `strategy.fail-fast` support.

### Patch Changes

- Updated dependencies [9b34858]
  - dtu-github-actions@0.3.0

## 0.2.0

### Minor Changes

- 7bce818: Initial release.

### Patch Changes

- e074b4c: Updated documentation.
- Updated dependencies [7bce818]
  - dtu-github-actions@0.2.0
