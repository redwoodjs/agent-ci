# Agent CI

**Run GitHub Actions on your machine. Caching in ~0 ms. Pause on failure. Fix and retry — before you commit, before you push.**

<p align="center">
  <img src="https://raw.githubusercontent.com/redwoodjs/agent-ci/main/.docs/marketing/demo.gif" alt="Agent CI demo — pause on failure, fix, retry" width="700" />
</p>

Agent CI is a ground-up rewrite of the GitHub Actions orchestration layer that runs entirely on your own machine. It doesn't wrap or shim the runner: it **replaces the cloud API** that the official [GitHub Actions Runner](https://github.com/actions/runner) talks to, so the same runner binary that executes your jobs on GitHub.com executes them locally, bit-for-bit.

Actions like `actions/checkout`, `actions/setup-node`, and `actions/cache` work out of the box — no patches, no forks, no network calls to GitHub. Dependencies that took a couple of minutes to install on GitHub's runners install in a few seconds on the second run, because the cache is bind-mounted — not uploaded, downloaded, or unpacked.

---

## Why Agent CI?

Remote CI is the final gatekeeper — it runs on every push and decides what ships. That's its job. The problem is what happens when it fails: you push, you wait, you read logs, you push again. Every retry pays the full cost of a fresh run, and the gatekeeper ends up being used as a debugger.

Agent CI is a **pre-flight check** that runs on your own machine before you commit. Catch the failure in seconds, fix it locally, only push work that's already green — and let remote CI stay the gatekeeper.

Existing "run actions locally" tools either re-implement steps in a compatibility layer or require you to maintain a separate config. Agent CI does neither.

|                            | GitHub Actions     | Other local runners      | **Agent CI**                            |
| -------------------------- | ------------------ | ------------------------ | --------------------------------------- |
| Runner binary              | Official           | Custom re-implementation | **Official**                            |
| API layer                  | GitHub.com         | Compatibility shim       | **Full local emulation**                |
| Cache round-trip           | Network (~seconds) | Varies                   | **~0 ms (bind-mount)**                  |
| On failure                 | Start over         | Start over               | **Pause → fix → retry the failed step** |
| Container state on failure | Destroyed          | Destroyed                | **Kept alive**                          |
| Requires a clean commit    | Yes                | Yes                      | **No — runs against working tree**      |

### ~0 ms caching

Agent CI replaces GitHub's cloud cache with **local bind-mounts**. `node_modules`, the pnpm store, Playwright browsers, and the runner tool cache all live on your host filesystem and are mounted directly into the container — no upload, no download, no tar/untar. The first run warms the cache; every subsequent run starts with hot dependencies instantly.

### Pause on failure

Step 6 failed. Fix the file. Retry just that step. Green. No checkout, no reinstall, no waiting.

When a step fails, Agent CI **pauses** instead of tearing down. The container stays alive with all state intact — environment variables, installed tools, intermediate build artifacts. Your edits on the host are synced into the container, so you (or your AI agent) can fix the issue and **retry just the failed step**.

### Real GitHub Actions Runner, real compatibility

Agent CI does not re-implement GitHub Actions. It emulates the **server-side API surface** — the Twirp endpoints, the Azure Block Blob artifact protocol, the cache REST API — and feeds jobs to the unmodified, official runner. If your workflow runs on GitHub, it runs here.

---

## Prerequisites

- **Docker** — a running Docker provider:
  - **macOS:** [OrbStack](https://orbstack.dev/) (recommended) or Docker Desktop
  - **Linux:** Native Docker Engine or Docker Desktop
- **Optional — for `runs-on: macos-*` jobs** (Apple Silicon Macs only):
  - [tart](https://github.com/cirruslabs/tart) — `brew install cirruslabs/cli/tart`
  - `sshpass` — `brew install hudochenkov/sshpass/sshpass`

  Without both, macOS jobs are skipped with a reason. See [macOS jobs](#macos-jobs) below.

## Quick start

```bash
# Run a specific workflow
npx @redwoodjs/agent-ci run --workflow .github/workflows/ci.yml

# Run all relevant workflows for the current branch
npx @redwoodjs/agent-ci run --all
```

Agent CI runs against your **current working tree** — uncommitted changes are included automatically. No need to commit or stash before running.

Committing is optional, but it's a useful pattern: commit → run → fail → fix with `--pause-on-failure` → retry → commit the fix. When you do commit, the commit becomes a save point you can return to if the fix makes things worse. Your AI agent benefits from the same pattern — it can roll back to a known-good state before trying a different fix.

### Retry a failed step

```bash
npx @redwoodjs/agent-ci retry --name <runner-name>
```

---

## CLI reference

### `agent-ci run`

Run GitHub Actions workflow jobs locally.

| Flag                       | Short | Description                                                                                                                                                  |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--workflow <path>`        | `-w`  | Path to the workflow file                                                                                                                                    |
| `--all`                    | `-a`  | Discover and run all relevant workflows for the current branch                                                                                               |
| `--jobs <n>`               | `-j`  | Max concurrent containers (overrides auto-detection)                                                                                                         |
| `--pause-on-failure`       | `-p`  | Pause on step failure for interactive debugging                                                                                                              |
| `--quiet`                  | `-q`  | Suppress animated rendering (also enabled by `AI_AGENT=1`)                                                                                                   |
| `--json`                   |       | Emit NDJSON event stream on stdout (also enabled by `AGENT_CI_JSON=1`); see [Agent output mode](#agent-output-mode-ndjson-event-stream)                      |
| `--no-matrix`              |       | Collapse all matrix combinations into a single job (uses first value of each key)                                                                            |
| `--github-token [<token>]` |       | GitHub token for fetching remote reusable workflows (auto-resolves via `gh auth token` if no value given). Also available as `AGENT_CI_GITHUB_TOKEN` env var |
| `--commit-status`          |       | Post a GitHub commit status after the run (requires `--github-token`)                                                                                        |

### `agent-ci retry`

Retry a paused runner after fixing the failure.

| Flag              | Short | Description                                   |
| ----------------- | ----- | --------------------------------------------- |
| `--name <name>`   | `-n`  | Name of the paused runner to retry (required) |
| `--from-step <N>` |       | Re-run from step N, skipping earlier steps    |
| `--from-start`    |       | Re-run all steps from the beginning           |

Without `--from-step` or `--from-start`, retry re-runs only the failed step (the default).

### `agent-ci abort`

Abort a paused runner and tear down its container.

| Flag            | Short | Description                                   |
| --------------- | ----- | --------------------------------------------- |
| `--name <name>` | `-n`  | Name of the paused runner to abort (required) |

---

## Secrets

Workflow secrets (`${{ secrets.FOO }}`) are resolved in order:

1. **`.env.agent-ci`** file in the repo root (`KEY=VALUE` syntax, `#` comments supported)
2. **Shell environment variables** — any env var matching a required secret name acts as a fallback
3. **`--github-token`** — automatically provides `secrets.GITHUB_TOKEN`

```bash
# All three approaches work:
# 1. .env.agent-ci file
echo "CLOUDFLARE_API_TOKEN=xxx" >> .env.agent-ci

# 2. Inline env vars
CLOUDFLARE_API_TOKEN=xxx agent-ci run -w .github/workflows/deploy.yml

# 3. --github-token for GITHUB_TOKEN specifically
agent-ci run -w .github/workflows/ci.yml --github-token
```

---

## Vars

Workflow variables (`${{ vars.FOO }}`) are provided exclusively via the `--var` CLI flag. There's no file-based lookup and no fallback to shell environment variables — this keeps workflow vars distinct from shell env vars and ensures every value is explicit on the command line.

```bash
agent-ci run -w .github/workflows/deploy.yml \
  --var DEPLOY_ENV=production \
  --var API_URL=https://api.example.com
```

If a workflow references a var (`${{ vars.FOO }}`) and no matching `--var FOO=...` flag is passed, the run fails with a message listing the missing vars.

---

## Environment variables

All configuration is available via environment variables. For persistent machine-local overrides, create a `.env.agent-ci` file in your project root — Agent CI loads it automatically (`KEY=VALUE` syntax, `#` comments supported).

Only `AGENT_CI_*`-prefixed keys from `.env.agent-ci` are applied to the CLI process environment (so they influence Docker/network resolution, etc.). Non-prefixed keys in the file are still resolved as workflow secrets via `${{ secrets.FOO }}`. Shell environment variables always take precedence over `.env.agent-ci` entries.

### General

| Variable                | Default                         | Description                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_REPO`           | auto-detected from `git remote` | Override the `owner/repo` used when emulating the GitHub API. Useful when the remote URL can't be detected automatically.                                                                                                                                                                    |
| `AI_AGENT`              | unset                           | Set to `1` to enable quiet mode (suppress animated rendering). Same effect as `--quiet`.                                                                                                                                                                                                     |
| `AGENT_CI_JSON`         | unset                           | Set to `1` to emit the NDJSON event stream on stdout. Same effect as `--json`.                                                                                                                                                                                                               |
| `AGENT_CI_DETACHED`     | unset                           | Set to `1` to force `--pause-on-failure` to use the detached launcher even on a TTY (for manual verification of the pause-then-exit-77 flow). The launcher uses this same env var internally to mark its worker child (with the worker's log path as the value), so do not set it to a path. |
| `DEBUG`                 | unset                           | Enable verbose debug logging. See [Debugging](#debugging) for supported namespaces.                                                                                                                                                                                                          |
| `AGENT_CI_GITHUB_TOKEN` | unset                           | GitHub token for fetching remote reusable workflows. Alternative to the `--github-token` CLI flag.                                                                                                                                                                                           |

### Docker

| Variable                                      | Default                             | Description                                                                                                                                                                                                       |
| --------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_CI_DOCKER_HOST`                        | `unix:///var/run/docker.sock`       | Docker daemon socket or URL. Set to `ssh://user@host` or `tcp://…` to use a remote daemon. **Note:** the standard `DOCKER_HOST` env var is not honoured — setting it causes agent-ci to exit with a rename error. |
| `AGENT_CI_DTU_HOST`                           | `host.docker.internal`              | Hostname or IP that runner containers use to reach the DTU mock server on the host.                                                                                                                               |
| `AGENT_CI_DOCKER_EXTRA_HOSTS`                 | `host.docker.internal:host-gateway` | Comma-separated `host:ip` entries passed to Docker `ExtraHosts`. Fully replaces the default when set.                                                                                                             |
| `AGENT_CI_DOCKER_HOST_GATEWAY`                | `host-gateway`                      | Override the default `host-gateway` token or IP for the automatic host mapping.                                                                                                                                   |
| `AGENT_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS` | unset                               | Set to `1` to disable the default `host.docker.internal` mapping.                                                                                                                                                 |
| `AGENT_CI_DOCKER_BRIDGE_GATEWAY`              | auto-detected                       | Fallback gateway IP when Agent CI runs inside Docker and cannot detect its container IP.                                                                                                                          |

---

## Runner image

By default, jobs run inside `ghcr.io/actions/actions-runner:latest` — the official self-hosted runner image. It includes the runner agent, Node.js, git, curl, jq, and unzip, but **not** build toolchains, `python3`, `xz`, or other tools that GitHub's hosted `ubuntu-latest` VM ships.

If a workflow fails with a missing tool, create a Dockerfile to add it:

```dockerfile
# .github/agent-ci.Dockerfile
FROM ghcr.io/actions/actions-runner:latest
RUN sudo apt-get update \
 && sudo apt-get install -y --no-install-recommends <your-packages> \
 && sudo rm -rf /var/lib/apt/lists/*
```

Agent CI picks it up automatically — no flags, no config. The image is built once and cached by content hash.

For the full guide — directory form with `COPY` support, per-job overrides, common recipes (Rust, Node native modules, Go, Ruby, Nix), the `AGENT_CI_RUNNER_IMAGE` escape hatch, and build caching details — see [runner-image.md](https://github.com/redwoodjs/agent-ci/blob/main/packages/cli/runner-image.md).

---

## macOS jobs

Jobs with `runs-on: macos-*` run in a real, throwaway macOS VM on Apple Silicon hosts with [tart](https://github.com/cirruslabs/tart) and `sshpass` installed. On any other host (Linux, Intel Mac, or missing tools), macOS jobs are skipped with a clear reason message.

The VM uses the official [cirruslabs](https://github.com/cirruslabs/macos-image-templates) images and is destroyed after the job finishes. The runner binary is fetched once and cached on the host.

Default image mapping:

| `runs-on:`               | Image                        |
| ------------------------ | ---------------------------- |
| `macos-13`               | `macos-ventura-xcode:latest` |
| `macos-14`               | `macos-sonoma-xcode:latest`  |
| `macos-15`               | `macos-sequoia-xcode:latest` |
| `macos-26`               | `macos-tahoe-xcode:latest`   |
| `macos` / `macos-latest` | `macos-sonoma-xcode:latest`  |

### Environment variables

| Variable                        | Default         | Description                                                                                                 |
| ------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `AGENT_CI_MACOS_VM_IMAGE`       | see table above | Override the image (e.g. `ghcr.io/cirruslabs/macos-sonoma-xcode:latest`).                                   |
| `AGENT_CI_MACOS_VM_CONCURRENCY` | `2`             | Max concurrent macOS VMs. tart's free tier allows 2 simultaneously — raise only if you have a tart license. |

### Caveats

- Only Apple Silicon hosts are supported — Virtualization.framework cannot run macOS guests on Intel Macs.
- Windows jobs (`runs-on: windows-*`) are not yet supported and always skip.

---

## Remote Docker

Agent CI connects to Docker via the `AGENT_CI_DOCKER_HOST` environment variable. By default it uses the local socket (`unix:///var/run/docker.sock`), but you can point it at any remote Docker daemon:

```bash
AGENT_CI_DOCKER_HOST=ssh://user@remote-server npx @redwoodjs/agent-ci run --workflow .github/workflows/ci.yml
```

> **Note:** the standard `DOCKER_HOST` env var is **not** honoured. If you have it set for the regular Docker CLI, agent-ci exits with an error asking you to rename to `AGENT_CI_DOCKER_HOST`. This lets agent-ci target a different daemon than your shell's `docker` CLI without the two colliding — and it lets the value live in `.env.agent-ci`.

### Docker host resolution for job containers

By default, Agent CI uses `host.docker.internal` for container-to-host DTU traffic and adds a default Docker host mapping:

- `host.docker.internal:host-gateway`

This keeps behavior OS-agnostic and works on Docker Desktop and modern native Docker.

If your setup is custom, use environment overrides:

- `AGENT_CI_DTU_HOST` — override the hostname/IP used by runner containers to reach DTU
- `AGENT_CI_DOCKER_EXTRA_HOSTS` — comma-separated `host:ip` entries passed to Docker `ExtraHosts` (full replacement for defaults)
- `AGENT_CI_DOCKER_HOST_GATEWAY` — override the default `host-gateway` token/IP for automatic mapping
- `AGENT_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS=1` — disable the default `host.docker.internal` mapping
- `AGENT_CI_DOCKER_BRIDGE_GATEWAY` — fallback gateway IP used when Agent CI runs inside Docker and cannot detect its container IP, and as an explicit DTU host override outside Docker when `AGENT_CI_DTU_HOST` is not set

When using a remote daemon (`AGENT_CI_DOCKER_HOST=ssh://...`), `host-gateway` resolves relative to the remote Docker host. If DTU is not reachable from that host, set `AGENT_CI_DTU_HOST` and `AGENT_CI_DOCKER_EXTRA_HOSTS` explicitly for your network.

---

## Concurrency

When running multiple workflows (`--all`), Agent CI limits how many containers run at the same time to avoid running out of memory.

The limit is auto-detected using two factors:

- **CPU**: `floor(cpuCount / 2)`
- **Memory**: `floor(availableDockerMemory / 4GB)`

Whichever is lower wins. For example, on a machine with 14 CPUs and a Docker VM with 12 GB of RAM, the CPU limit is 7 and the memory limit is 2 — so 2 containers run at a time.

To check available memory, Agent CI reads `MemAvailable` from `/proc/meminfo` inside the Docker VM. This accounts for the VM's kernel, daemon, and any other running containers. If that fails, it falls back to `docker info` total memory minus 4 GB.

You can override the auto-detected limit with `--jobs`:

```bash
# Run at most 4 containers at a time
npx @redwoodjs/agent-ci run --all --jobs 4

# Run one at a time (safest, slowest)
npx @redwoodjs/agent-ci run --all --jobs 1
```

---

## YAML compatibility

See [compatibility.md](https://github.com/redwoodjs/agent-ci/blob/main/packages/cli/compatibility.md) for detailed GitHub Actions workflow syntax support.

## Debugging

Set the `DEBUG` environment variable to enable verbose debug logging. It accepts a comma-separated list of glob patterns matching the namespaces you want to see:

| Value                             | What it shows                 |
| --------------------------------- | ----------------------------- |
| `DEBUG=agent-ci:*`                | All debug output              |
| `DEBUG=agent-ci:cli`              | CLI-level logs only           |
| `DEBUG=agent-ci:runner`           | Runner/container logs only    |
| `DEBUG=agent-ci:dtu`              | DTU mock-server logs only     |
| `DEBUG=agent-ci:boot`             | Boot/startup timing logs only |
| `DEBUG=agent-ci:cli,agent-ci:dtu` | Multiple namespaces           |

- Output goes to **stderr** so stdout stays clean for piping.
- If `DEBUG` is unset or empty, all debug loggers become **no-ops** (zero overhead).
- Pattern matching uses [minimatch](https://github.com/isaacs/minimatch) globs, so `agent-ci:*` matches all four namespaces.

```bash
DEBUG=agent-ci:* npx @redwoodjs/agent-ci run --workflow .github/workflows/ci.yml
```

---

## Agent output mode (NDJSON event stream)

When `--json` is passed (or `AGENT_CI_JSON=1` is set), Agent CI emits a
structured stream of newline-delimited JSON events on stdout — one JSON
object per line, each with an `event` discriminator field. Wrappers (LLM
agents, status dashboards, TUIs) can parse these instead of regex-scraping
the human-readable output.

`--json` is decoupled from `--quiet`/`AI_AGENT=1`: the latter only suppresses
the animated renderer. Pass both to combine "no terminal animation" with
"machine-readable stream." The animated renderer is automatically suppressed
when `--json` is set so its ANSI sequences don't collide with the JSON
stream on stdout.

The schema is versioned via `schemaVersion` on `run.start`. Version `1` defines
these events:

| Event         | Required fields                                                                | Optional fields                     |
| ------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| `run.start`   | `ts`, `schemaVersion`, `runId`                                                 | `repo`, `branch`                    |
| `run.finish`  | `status` (`passed`/`failed`)                                                   | `ts`, `durationMs`                  |
| `run.paused`  | `runner`, `retry_cmd`                                                          | `ts`, `step`, `attempt`, `workflow` |
| `job.start`   | `ts`, `job`, `runner`                                                          | `workflow`                          |
| `job.finish`  | `ts`, `job`, `runner`, `status`                                                | `workflow`, `durationMs`            |
| `step.start`  | `ts`, `job`, `runner`, `step`, `index`                                         |                                     |
| `step.finish` | `ts`, `job`, `runner`, `step`, `index`, `status` (`passed`/`failed`/`skipped`) | `durationMs`                        |
| `diagnostic`  | `ts`, `level` (`info`/`warning`/`error`), `message`                            |                                     |

Example:

```json
{"event":"run.start","ts":"2026-04-28T10:15:00.000Z","schemaVersion":1,"runId":"run-1745837700000"}
{"event":"job.start","ts":"…","job":"lint","runner":"agent-ci-1-job","workflow":"ci.yml"}
{"event":"step.start","ts":"…","job":"lint","runner":"agent-ci-1-job","step":"eslint","index":1}
{"event":"step.finish","ts":"…","job":"lint","runner":"agent-ci-1-job","step":"eslint","index":1,"status":"passed","durationMs":4123}
{"event":"job.finish","ts":"…","job":"lint","runner":"agent-ci-1-job","workflow":"ci.yml","status":"passed","durationMs":8000}
{"event":"run.finish","ts":"…","status":"passed","durationMs":18210}
```

Stderr carries the existing human-readable progress lines and is kept free
of NDJSON noise. Non-JSON output passes through unchanged on stdout.

## The agentic dev loop

The loop: commit → Agent CI runs → failure → your agent fixes the file in place with `--pause-on-failure` → retry the failed step → commit the fix → push. The bind-mounted cache and paused container are what make this loop tight enough to actually work — your agent isn't waiting minutes for a fresh install between attempts.

Install the agent skill:

```bash
npx skills add redwoodjs/agent-ci --skill agent-ci
```

This works with Claude Code, Cursor, Codex, and [40+ other agents](https://agentskills.io). Then add to your agent instructions (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, etc.):

```markdown
## CI

Install the agent-ci skill (one-time setup):

\`\`\`bash
npx skills add redwoodjs/agent-ci --skill agent-ci
\`\`\`

Before completing any work, run the `agent-ci` skill to validate your changes locally. If it fails, fix the issue and re-run. Do not report work as done until it passes.
```
