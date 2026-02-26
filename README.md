# Opposite-Actions

**Opposite-Actions**

!!!
is a local-first CI runner system. It allows GitHub Actions to execute on your own hardware (your MacBook) while providing a seamless fallback to GitHub-hosted runners when you are offline.

Unlike standard ephemeral runners, **Opposite-Actions** is designed to **freeze on failure**, preserving the Docker container and local filesystem for immediate, interactive debugging.

---

## Project Structure

This project is organized as a `pnpm` workspace:

- [bridge/](./bridge): A Cloudflare Worker that orchestrates jobs and presence.
- [supervisor/](./supervisor): A Node.js agent that polls the bridge and runs Docker jobs.
- [dtu-github-actions/](./dtu-github-actions): Digital Twin Universe mock tools for local simulation.

---

## Getting Started

### 1. Prerequisites

- `pnpm` (v10+)
- `Docker` installed and running.

### 2. Install Dependencies

Run from the root directory:

```bash
pnpm install
```

### 3. Environment Setup

Shared environment variables are managed at the root.

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env` and `.dev.vars` at the root as needed.

> [!NOTE]
> All services use symbolic links pointing back to these root files:
>
> - `bridge/.env` -> `../.env`
> - `supervisor/.env` -> `../.env`
> - `dtu/github-actions/.env` -> `../../.env`

---

## Run Locally

You can run all services in the required sequence from the root:

```bash
pnpm dev
```

This command uses `concurrently` and `wait-on` to ensure:

1. `dtu/github-actions` (Mock Server) starts first on port 8910.
2. `bridge` waits for the mock server to be ready and starts on port 8911.
3. `supervisor` waits for the bridge to be ready.

Or target specific services:

```bash
pnpm --filter dtu/github-actions dev
pnpm --filter bridge dev
```

---

## System Architecture

The system consists of three primary technical components:

1.  **Cloudflare Worker (Orchestrator):** The source of truth for runner availability. It queues jobs and manages "Heartbeats" from local nodes.
2.  **Local Supervisor (Agent):** A Node.js daemon running on your MacBook that polls for jobs and manages the Docker lifecycle.
3.  **Docker Environment (Execution):** Standard `ghcr.io/actions/actions-runner` containers that perform the work.

---

## The Fallback Logic

The system ensures that your PRs are never blocked. It uses a dynamic `runs-on` strategy based on your current local availability.

### Workflow Configuration (`.github/workflows/ci.yml`)

```yaml
jobs:
  check-availability:
    runs-on: ubuntu-latest
    outputs:
      target_runner: ${{ steps.status.outputs.label }}
    steps:
      - id: status
        run: |
          # Query the Cloudflare Orchestrator for local agent presence
          RESPONSE=$(curl -s https://oa-1.redwoodjs.workers.dev/api/presence?username=${{ github.actor }})
          if [ "$RESPONSE" == "active" ]; then
            echo "label=self-hosted" >> $GITHUB_OUTPUT
          else
            echo "label=ubuntu-latest" >> $GITHUB_OUTPUT
          fi

  test:
    needs: check-availability
    runs-on: ${{ needs.check-availability.outputs.target_runner }}
    steps:
      - uses: actions/checkout@v4
      - name: Run Tests
        run: |
          # Your standard test commands
          pnpm test
```

---

## Tool Cache & Setup Actions

Unlike GitHub-hosted `ubuntu-latest` runners that come pre-populated with gigabytes of tools (like Node.js, Python, Go, etc.), the `opposite-actions` self-hosted runner starts with an empty cache.

This means the _very first time_ a workflow uses an action like `actions/setup-node`, it will need to download the tool from the internet, taking slightly longer. However, the downloaded tools are saved to a persistent `toolcache` directory on your host machine. All subsequent runs and containers will instantly mount and find the tools in the cache, skipping the download step.
