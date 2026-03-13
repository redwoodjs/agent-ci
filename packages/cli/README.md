# Agent CI

Agent CI is local CI for agents. It pauses when a workflow fails, allowing your agent to fix the issue and resume the workflow. Think of it as "live-reload for CI."

Agent CI runs your GitHub Actions workflows locally using the same [official GitHub Action runners](https://github.com/actions/runner) — the exact same binaries that power GitHub-hosted CI. What Agent CI emulates is the GitHub.com API itself, so actions like `actions/checkout`, `actions/setup-node`, and `actions/cache` work out of the box without hitting GitHub's servers.

## Why Agent CI?

Traditional CI is a fire-and-forget loop: push, wait, fail, read logs, push again. Every retry pays the full cost of a new run.

Agent CI runs on any machine that can run a container. When a step fails the run **pauses** — the container stays alive with all state intact. Your edits are synced into the container on retry, so you can fix the issue and **retry just the failed step** — no checkout, no reinstall, no waiting. This makes it ideal for AI agents: point an agent at the failure, let it fix and retry in a tight loop — without the cost of a full remote CI cycle each time.

<!-- TODO: Add demo video/screen recording -->

## Installation

```bash
npm install -g agent-ci
```

### Prerequisites

- **Docker** — A running Docker provider:
  - **macOS:** [OrbStack](https://orbstack.dev/) (recommended) or Docker Desktop
  - **Linux:** Native Docker Engine

### Remote Docker

Agent CI connects to Docker via the `DOCKER_HOST` environment variable. By default it uses the local socket (`unix:///var/run/docker.sock`), but you can point it at any remote Docker daemon:

```bash
# Run containers on a remote machine via SSH
DOCKER_HOST=ssh://user@remote-server agent-ci run --workflow .github/workflows/ci.yml
```

## Usage

```bash
# Run a specific workflow
agent-ci run --workflow .github/workflows/ci.yml

# Run all relevant workflows for the current branch
agent-ci run --all
```

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

## YAML Compatibility

See [compatibility.md](./compatibility.md) for detailed GitHub Actions workflow syntax support.
