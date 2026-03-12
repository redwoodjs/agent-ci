# Agent CI

## Development

### 1. Prerequisites

- `pnpm` (v10+)
- A Docker provider running on your machine:
  - **macOS:** We highly recommend [OrbStack](https://orbstack.dev/) for its speed, low battery usage, and network integration.

### 2. Install Dependencies

Run from the root directory:

```bash
pnpm install
```

### 3. Ready

No environment configuration is needed — the CLI derives everything at boot:

- **Repository**: detected from `git remote get-url origin`
- **DTU (mock GitHub API)**: started ephemerally on a random port per run
- **Webhook secret**: hardcoded for local-only mock usage

---

## Running Parallel AI Agents (Devcontainers)

Each agent runs in an isolated VS Code devcontainer with its own git worktree, so multiple agents can work on separate branches simultaneously.

### Prerequisites

- [VS Code](https://code.visualstudio.com/) with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
- Docker running locally
- The `code` CLI installed: VS Code → Command Palette → **"Shell Command: Install code command in PATH"**

### Start an Agent

```bash
# Start an agent on a new or existing branch (slot assigned automatically)
./scripts/agents-up.sh <branch>

# Start an agent on a specific slot number
./scripts/agents-up.sh <branch> <N>
```

This will:

1. Create a git worktree at `../agent-ci-agent-N/` checked out to `<branch>` (creating the branch from HEAD if it doesn't exist)
2. Generate a `devcontainer.json` inside the worktree
3. Open a new VS Code window connected to the devcontainer

### First-Time Authentication

Claude Code OAuth tokens are stored in the macOS Keychain and are not accessible from a Linux container. The first time you start an agent, you'll need to log in manually inside the container:

```
claude /login
```

Credentials are stored in `~/.claude/` and `~/.claude.json`, which are bind-mounted from your host, so they persist across container rebuilds and are shared between agents.

### Mounts

Each container shares the following from your host machine:

| Host path                      | Container path                  | Purpose                                 |
| ------------------------------ | ------------------------------- | --------------------------------------- |
| `~/.claude.json`               | `/root/.claude.json`            | Claude Code credentials                 |
| `~/.claude/`                   | `/root/.claude/`                | Claude Code settings & session data     |
| `~/.config/gh/`                | `/root/.config/gh/`             | GitHub CLI credentials                  |
| `<repo>/.git`                  | `<repo>/.git`                   | Main git repo (for worktree resolution) |
| `/var/run/docker.sock`         | `/var/run/docker.sock`          | Docker-outside-of-Docker                |
| `agent-ci-pnpm-store` (volume) | `/root/.local/share/pnpm/store` | Shared pnpm cache                       |

---

## Run Locally

```bash
pnpm agent-ci-dev run --workflow .github/workflows/tests.yml
```

To run all relevant PR/Push workflows for your current branch:

```bash
pnpm agent-ci-dev run --all
```

A workflow is **relevant** if its `on:` trigger includes:

- **`pull_request`** — targeting `main` (respecting `branches` / `branches-ignore` filters)
- **`push`** — matching the current branch (respecting `branches` / `branches-ignore` filters)

Both events also respect `paths` / `paths-ignore` filters: agent-ci compares the files
changed in the current commit (`git diff --name-only HEAD~1`) against the workflow's
path patterns and skips workflows that don't match.

Workflows triggered only by `schedule`, `workflow_dispatch`, `release`, etc. are skipped.
