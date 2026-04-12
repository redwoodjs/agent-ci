# Agent CI

**Run GitHub Actions on your machine. Caching in ~0 ms. Pause on failure. Let your agent fix it and retry — without pushing.**

<p align="center">
  <img src=".docs/marketing/demo.gif" alt="Agent CI demo — pause on failure, fix, retry" width="700" />
</p>

Agent CI is a ground-up rewrite of the GitHub Actions orchestration layer that runs entirely on your own machine. It doesn't wrap or shim the runner: it **replaces the cloud API** that the official [GitHub Actions Runner](https://github.com/actions/runner) talks to, so the same runner binary that executes your jobs on GitHub.com executes them locally, bit-for-bit.

Actions like `actions/checkout`, `actions/setup-node`, and `actions/cache` work out of the box — no patches, no forks, no network calls to GitHub.

---

## Why another local runner?

Traditional CI is a fire-and-forget loop: push → wait → fail → read logs → push again. Every retry pays the **full cost** of a fresh run. Existing "run actions locally" tools either re-implement steps in a compatibility layer or require you to maintain a separate config. Agent CI does neither.

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

When a step fails, Agent CI **pauses** instead of tearing down. The container stays alive with all state intact — environment variables, installed tools, intermediate build artifacts. Your edits on the host are synced into the container, so you (or your AI agent) can fix the issue and **retry just the failed step**. No checkout, no reinstall, no waiting.

This makes Agent CI ideal for **AI-agent-driven development**: point an agent at the failure, let it fix and retry in a tight loop — without the cost of a full remote CI cycle each time.

### Real GitHub Actions Runner, real compatibility

Agent CI does not re-implement GitHub Actions. It emulates the **server-side API surface** — the Twirp endpoints, the Azure Block Blob artifact protocol, the cache REST API — and feeds jobs to the unmodified, official runner. If your workflow runs on GitHub, it runs here.

---

## Quick start

### Prerequisites

- **Docker** — a running Docker provider:
  - **macOS:** [OrbStack](https://orbstack.dev/) (recommended) or Docker Desktop
  - **Linux:** Native Docker Engine

### Install

```bash
npm install -D @redwoodjs/agent-ci
```

### Run

```bash
# Run a specific workflow
npx agent-ci run --workflow .github/workflows/ci.yml

# Run all relevant workflows for the current branch
npx agent-ci run --all
```

Agent CI runs against your **current working tree** — uncommitted changes are included automatically. No need to commit or stash before running.

### Retry a failed step

```bash
npx agent-ci retry --name <runner-name>
```

---

## CLI reference

### `agent-ci run`

Run GitHub Actions workflow jobs locally.

| Flag                       | Short | Description                                                                                                                                                  |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--workflow <path>`        | `-w`  | Path to the workflow file                                                                                                                                    |
| `--all`                    | `-a`  | Discover and run all relevant workflows for the current branch                                                                                               |
| `--pause-on-failure`       | `-p`  | Pause on step failure for interactive debugging                                                                                                              |
| `--quiet`                  | `-q`  | Suppress animated rendering (also enabled by `AI_AGENT=1`)                                                                                                   |
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

### Remote Docker

Agent CI connects to Docker via `DOCKER_HOST`. By default it uses the local socket, but you can point it at any remote daemon:

```bash
DOCKER_HOST=ssh://user@remote-server npx agent-ci run --workflow .github/workflows/ci.yml
```

### Docker host resolution for job containers

For default behavior, env overrides, and remote-daemon caveats, see the CLI package docs:

- [`packages/cli/README.md#docker-host-resolution-for-job-containers`](./packages/cli/README.md#docker-host-resolution-for-job-containers)

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

## Environment variables

All configuration is available via environment variables. For persistent machine-local overrides, create a `.env.agent-ci` file in your project root — Agent CI loads it automatically (`KEY=VALUE` syntax, `#` comments supported).

### General

| Variable                | Default                         | Description                                                                                                               |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_REPO`           | auto-detected from `git remote` | Override the `owner/repo` used when emulating the GitHub API. Useful when the remote URL can't be detected automatically. |
| `AI_AGENT`              | unset                           | Set to `1` to enable quiet mode (suppress animated rendering). Same effect as `--quiet`.                                  |
| `DEBUG`                 | unset                           | Enable verbose debug logging. See [Debugging](#debugging) for supported namespaces.                                       |
| `AGENT_CI_GITHUB_TOKEN` | unset                           | GitHub token for fetching remote reusable workflows. Alternative to the `--github-token` CLI flag.                        |

### Docker

| Variable                                      | Default                             | Description                                                                                           |
| --------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `DOCKER_HOST`                                 | `unix:///var/run/docker.sock`       | Docker daemon socket or URL. Set to `ssh://user@host` to use a remote daemon.                         |
| `AGENT_CI_DTU_HOST`                           | `host.docker.internal`              | Hostname or IP that runner containers use to reach the DTU mock server on the host.                   |
| `AGENT_CI_DOCKER_EXTRA_HOSTS`                 | `host.docker.internal:host-gateway` | Comma-separated `host:ip` entries passed to Docker `ExtraHosts`. Fully replaces the default when set. |
| `AGENT_CI_DOCKER_HOST_GATEWAY`                | `host-gateway`                      | Override the default `host-gateway` token or IP for the automatic host mapping.                       |
| `AGENT_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS` | unset                               | Set to `1` to disable the default `host.docker.internal` mapping.                                     |
| `AGENT_CI_DOCKER_BRIDGE_GATEWAY`              | auto-detected                       | Fallback gateway IP when Agent CI runs inside Docker and cannot detect its container IP.              |

---

## YAML compatibility

See [compatibility.md](./packages/cli/compatibility.md) for detailed GitHub Actions workflow syntax support.

## Debugging

Set `DEBUG` to enable verbose logging. It accepts comma-separated glob patterns:

| Value                             | What it shows                 |
| --------------------------------- | ----------------------------- |
| `DEBUG=agent-ci:*`                | All debug output              |
| `DEBUG=agent-ci:cli`              | CLI-level logs only           |
| `DEBUG=agent-ci:runner`           | Runner/container logs only    |
| `DEBUG=agent-ci:dtu`              | DTU mock-server logs only     |
| `DEBUG=agent-ci:boot`             | Boot/startup timing logs only |
| `DEBUG=agent-ci:cli,agent-ci:dtu` | Multiple namespaces           |

```bash
DEBUG=agent-ci:* npx agent-ci run --workflow .github/workflows/ci.yml
```

Output goes to **stderr**. If `DEBUG` is unset, debug loggers are no-ops with zero overhead.

---

## Using with AI coding agents

Install the agent skill:

```bash
npx skills add redwoodjs/agent-ci --skill agent-ci
```

This works with Claude Code, Cursor, Codex, and [40+ other agents](https://agentskills.io). Then add to your agent instructions (`CLAUDE.md`, `.cursorrules`, `AGENTS.md`, etc.):

```markdown
## CI

Before completing any work, you MUST run and pass CI locally:

- Run: `npx @redwoodjs/agent-ci run --quiet --all --pause-on-failure`
- When a step fails, the run pauses automatically. Fix the issue and retry: `npx @redwoodjs/agent-ci retry --name <runner>`
- CI was green before you started. Any failure is caused by your changes — do not assume pre-existing failures
- Do NOT push to trigger remote CI when agent-ci can run it locally
```

**Claude Code:** Agent CI also ships a `/validate` command. Copy [`.claude/commands/validate.md`](.claude/commands/validate.md) into your project for automatic background execution with monitoring and retry.
