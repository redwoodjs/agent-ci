# Agent CI

Agent CI is local CI for agents. It pauses when a workflow fails, allowing your agent to fix the issue and resume the workflow. Think of it as "live-reload for CI."

Agent CI runs your GitHub Actions workflows locally using the same [official GitHub Action runners](https://github.com/actions/runner) — the exact same binaries that power GitHub-hosted CI. What Agent CI emulates is the GitHub.com API itself, so actions like `actions/checkout`, `actions/setup-node`, and `actions/cache` work out of the box without hitting GitHub's servers.

## Why Agent CI?

Traditional CI is a fire-and-forget loop: push, wait, fail, read logs, push again. Every retry pays the full cost of a new run.

Agent CI runs on any machine that can run a container. When a step fails the run **pauses** — the container stays alive with all state intact. Your edits are synced into the container on retry, so you can fix the issue and **retry just the failed step** — no checkout, no reinstall, no waiting. This makes it ideal for AI agents: point an agent at the failure, let it fix and retry in a tight loop — without the cost of a full remote CI cycle each time.

<!-- TODO: Add demo video/screen recording -->

## Prerequisites

- **Docker** — A running Docker provider:
  - **macOS:** [OrbStack](https://orbstack.dev/) (recommended) or Docker Desktop
  - **Linux:** Native Docker Engine

## Installation

```bash
npm install -D @redwoodjs/agent-ci
```

## Usage

```bash
# Run a specific workflow
npx agent-ci run --workflow .github/workflows/ci.yml

# Run all relevant workflows for the current branch
npx agent-ci run --all
```

## Codex plugin

Agent CI also ships a Codex-ready plugin bundle under `codex-plugin/`.

If you already install `@redwoodjs/agent-ci` in a repo, you can point Codex straight at the bundled skill:

```toml
[[skills.config]]
path = "/absolute/path/to/node_modules/@redwoodjs/agent-ci/codex-plugin/skills/agent-ci/SKILL.md"
enabled = true
```

The bundle also includes a full plugin manifest if you prefer plugin-style installation from the `codex-plugin/` directory.

### Remote Docker

Agent CI connects to Docker via the `DOCKER_HOST` environment variable. By default it uses the local socket (`unix:///var/run/docker.sock`), but you can point it at any remote Docker daemon:

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

### `agent-ci run`

Run GitHub Actions workflow jobs locally.

| Flag                 | Short | Description                                                                       |
| -------------------- | ----- | --------------------------------------------------------------------------------- |
| `--workflow <path>`  | `-w`  | Path to the workflow file                                                         |
| `--all`              | `-a`  | Discover and run all relevant workflows for the current branch                    |
| `--pause-on-failure` | `-p`  | Pause on step failure for interactive debugging                                   |
| `--quiet`            | `-q`  | Suppress animated rendering (also enabled by `AI_AGENT=1`)                        |
| `--no-matrix`        |       | Collapse all matrix combinations into a single job (uses first value of each key) |

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

## YAML Compatibility

See [compatibility.md](./compatibility.md) for detailed GitHub Actions workflow syntax support.

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
DEBUG=agent-ci:* npx agent-ci run
```
