# Machinen

Machinen is local CI for agents. It pauses when a workflow fails, allowing your agent to fix the issue and resume the workflow. Think of it as "live-reload for CI."

Machinen runs your GitHub Actions workflows locally using the same [official GitHub Action runners](https://github.com/actions/runner) — the exact same binaries that power GitHub-hosted CI. What Machinen emulates is the GitHub.com API itself, so actions like `actions/checkout`, `actions/setup-node`, and `actions/cache` work out of the box without hitting GitHub's servers.

## Why Machinen?

Traditional CI is a fire-and-forget loop: push, wait, fail, read logs, push again. Every retry pays the full cost of a new run.

Machinen runs on the same machine as your code. When a step fails the run **pauses** — the container stays alive with all state intact. Your local edits are synced into the container on retry, so you can fix the issue and **retry just the failed step** — no checkout, no reinstall, no waiting. This makes it ideal for AI agents: point an agent at the failure, let it fix and retry in a tight loop — without the cost of a full remote CI cycle each time.

<!-- TODO: Add demo video/screen recording -->

## Installation

```bash
npm install -g machinen
```

### Prerequisites

- **Docker** — A running Docker provider:
  - **macOS:** [OrbStack](https://orbstack.dev/) (recommended) or Docker Desktop
  - **Linux:** Native Docker Engine

## Usage

Point Machinen at any workflow file in your repo:

```bash
machinen run --workflow .github/workflows/ci.yml
```

## YAML Compatibility

> [!NOTE]
> A full table of supported vs. unsupported GitHub Actions YAML features is coming soon.
