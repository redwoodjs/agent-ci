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

Machinen aims to run real GitHub Actions workflows locally. The table below shows current support against the [official workflow syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions).

✅ = Supported &nbsp; ⚠️ = Partial &nbsp; ❌ = Not supported &nbsp; 🟡 = Ignored (no-op)

### Workflow-Level Keys

| Key                                | Status | Notes                                      |
| ---------------------------------- | ------ | ------------------------------------------ |
| `name`                             | ✅     |                                            |
| `run-name`                         | 🟡     | Parsed but not displayed                   |
| `on` (push, pull_request)          | ✅     | Branch/path filters evaluated by `--all`   |
| `on` (schedule, workflow_dispatch) | 🟡     | Accepted but triggers are not simulated    |
| `on` (workflow_call)               | ❌     | Reusable workflow calls not supported      |
| `on` (other events)                | 🟡     | Parsed, not simulated                      |
| `env`                              | ✅     | Workflow-level env propagated to steps     |
| `defaults.run.shell`               | ✅     | Passed through to the runner               |
| `defaults.run.working-directory`   | ✅     | Passed through to the runner               |
| `permissions`                      | 🟡     | Accepted, not enforced (mock GITHUB_TOKEN) |
| `concurrency`                      | ❌     |                                            |

### Job-Level Keys

| Key                                   | Status | Notes                                                  |
| ------------------------------------- | ------ | ------------------------------------------------------ |
| `jobs.<id>`                           | ✅     | Multiple jobs in a single workflow                     |
| `jobs.<id>.name`                      | ✅     |                                                        |
| `jobs.<id>.needs`                     | ✅     | Topological sort into dependency waves                 |
| `jobs.<id>.if`                        | ❌     | Job-level conditions not evaluated                     |
| `jobs.<id>.runs-on`                   | 🟡     | Accepted; always runs in a Linux container             |
| `jobs.<id>.environment`               | 🟡     | Accepted, not enforced                                 |
| `jobs.<id>.env`                       | ✅     |                                                        |
| `jobs.<id>.defaults.run`              | ✅     | shell, working-directory                               |
| `jobs.<id>.outputs`                   | ❌     | Cross-job output passing not wired                     |
| `jobs.<id>.timeout-minutes`           | ❌     |                                                        |
| `jobs.<id>.continue-on-error`         | ❌     |                                                        |
| `jobs.<id>.concurrency`               | ❌     |                                                        |
| `jobs.<id>.container`                 | ✅     | Short & long form; image, env, ports, volumes, options |
| `jobs.<id>.services`                  | ✅     | Sidecar containers with image, env, ports, options     |
| `jobs.<id>.uses` (reusable workflows) | ❌     |                                                        |
| `jobs.<id>.secrets`                   | ❌     | Use `.env.machinen` file instead                       |

### Strategy / Matrix

| Key                       | Status | Notes                                              |
| ------------------------- | ------ | -------------------------------------------------- |
| `strategy.matrix`         | ✅     | Cartesian product expansion                        |
| `strategy.matrix.include` | ❌     |                                                    |
| `strategy.matrix.exclude` | ❌     |                                                    |
| `strategy.fail-fast`      | ❌     | Currently always aborts remaining waves on failure |
| `strategy.max-parallel`   | ❌     | Controlled by host concurrency, not per-job        |

### Step-Level Keys

| Key                          | Status | Notes                                                                                          |
| ---------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `steps[*].id`                | ✅     |                                                                                                |
| `steps[*].name`              | ✅     | Expression expansion in names                                                                  |
| `steps[*].if`                | ⚠️     | Evaluated by the runner, not by Machinen; `steps.*.outputs.cache-hit` resolves to empty string |
| `steps[*].run`               | ✅     | Multiline scripts, `${{ }}` expansion                                                          |
| `steps[*].uses`              | ✅     | Public actions downloaded via GitHub API                                                       |
| `steps[*].with`              | ✅     | Expression expansion in values                                                                 |
| `steps[*].env`               | ✅     | Expression expansion in values                                                                 |
| `steps[*].working-directory` | ✅     |                                                                                                |
| `steps[*].shell`             | ✅     | Passed through to the runner                                                                   |
| `steps[*].continue-on-error` | ❌     |                                                                                                |
| `steps[*].timeout-minutes`   | ❌     |                                                                                                |

### Expressions (`${{ }}`)

| Expression                                                 | Status | Notes                                           |
| ---------------------------------------------------------- | ------ | ----------------------------------------------- |
| `hashFiles(...)`                                           | ✅     | SHA-256 of matching files, multi-glob           |
| `format(...)`                                              | ✅     | Template substitution with recursive expansion  |
| `matrix.*`                                                 | ✅     |                                                 |
| `secrets.*`                                                | ✅     | Via `.env.machinen` file                        |
| `runner.os`                                                | ✅     | Always returns `Linux`                          |
| `runner.arch`                                              | ✅     | Always returns `X64`                            |
| `github.sha`, `github.ref_name`, etc.                      | ⚠️     | Returns static/dummy values                     |
| `github.event.*`                                           | ⚠️     | Returns empty strings                           |
| `strategy.job-total`, `strategy.job-index`                 | ✅     |                                                 |
| `steps.*.outputs.*`                                        | ⚠️     | Resolves to empty string at parse time          |
| `needs.*.outputs.*`                                        | ❌     | Resolves to empty string                        |
| Boolean/comparison operators                               | ❌     | The runner handles `if:` expressions internally |
| `toJSON`, `fromJSON`, `contains`, `startsWith`, `endsWith` | ❌     |                                                 |
| `success()`, `failure()`, `always()`, `cancelled()`        | ⚠️     | Evaluated by the runner, not by Machinen        |

### GitHub API Features (DTU Mock)

| Feature                                                 | Status | Notes                                                         |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| Action downloads                                        | ✅     | Resolves tarballs from github.com                             |
| `actions/cache`                                         | ✅     | Local filesystem cache with virtual (bind-mount) fast path    |
| `actions/checkout`                                      | ✅     | Workspace is rsynced; checkout configured with `clean: false` |
| `actions/setup-node`, `actions/setup-python`, etc.      | ✅     | Run natively within the runner                                |
| `actions/upload-artifact` / `download-artifact`         | ✅     | Local filesystem storage                                      |
| GITHUB_TOKEN                                            | ✅     | Mock token, all API calls answered locally                    |
| Workflow commands (`::set-output::`, `::error::`, etc.) | ✅     | Handled by the runner                                         |
