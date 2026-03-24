# Agent CI

**Run GitHub Actions on your machine. Caching in ~0 ms. Pause on failure. Let your agent fix it and retry — without pushing.**

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

### Retry a failed step

```bash
npx agent-ci retry --name <runner-name>
```

---

## CLI reference

### `agent-ci run`

Run GitHub Actions workflow jobs locally.

| Flag                 | Short | Description                                                    |
| -------------------- | ----- | -------------------------------------------------------------- |
| `--workflow <path>`  | `-w`  | Path to the workflow file                                      |
| `--all`              | `-a`  | Discover and run all relevant workflows for the current branch |
| `--pause-on-failure` | `-p`  | Pause on step failure for interactive debugging                |
| `--quiet`            | `-q`  | Suppress animated rendering (also enabled by `AI_AGENT=1`)     |

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

By default, Agent CI uses `host.docker.internal` for container-to-host DTU traffic and adds a default Docker host mapping:

- `host.docker.internal:host-gateway`

This keeps behavior OS-agnostic and works on Docker Desktop and modern native Docker.

If your setup is custom, use environment overrides:

- `AGENT_CI_DTU_HOST` - override the hostname/IP used by runner containers to reach DTU
- `AGENT_CI_DOCKER_EXTRA_HOSTS` - comma-separated `host:ip` entries passed to Docker `ExtraHosts` (full replacement for defaults)
- `AGENT_CI_DOCKER_HOST_GATEWAY` - override the default `host-gateway` token/IP for automatic mapping
- `AGENT_CI_DOCKER_DISABLE_DEFAULT_EXTRA_HOSTS=1` - disable the default `host.docker.internal` mapping
- `AGENT_CI_DOCKER_BRIDGE_GATEWAY` - fallback gateway IP used when Agent CI runs inside Docker and cannot detect its container IP, and as an explicit DTU host override outside Docker when `AGENT_CI_DTU_HOST` is not set

When using a remote daemon (`DOCKER_HOST=ssh://...`), `host-gateway` resolves relative to the remote Docker host. If DTU is not reachable from that host, set `AGENT_CI_DTU_HOST` and `AGENT_CI_DOCKER_EXTRA_HOSTS` explicitly for your network.

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
