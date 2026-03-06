# Machinen

**Machinen**

!!!
is a local-first CI runner system. It allows GitHub Actions to execute on your own hardware (your MacBook) while providing a seamless fallback to GitHub-hosted runners when you are offline.

Unlike standard ephemeral runners, **Machinen** is designed to **freeze on failure**, preserving the Docker container and local filesystem for immediate, interactive debugging.

---

## Project Structure

This project is organized as a `pnpm` workspace: !!!!!!!!!!!

- [bridge/](./bridge): A Cloudflare Worker that orchestrates jobs and presence.
- [cli/](./cli): A Node.js agent that polls the bridge and runs Docker jobs.
- [dtu-github-actions/](./dtu-github-actions): Digital Twin Universe mock tools for local simulation.

---

## Getting Started

### 1. Prerequisites

- `pnpm` (v10+)
- A Docker provider running on your machine:
  - **macOS:** We highly recommend [OrbStack](https://orbstack.dev/) for its speed, low battery usage, and network integration. Alternatively, you can use Docker Desktop or Colima.
  - **Linux:** Native Docker Engine.

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

## Run Locally

### Full Services Stack

You can run all services in the required sequence from the root:

```bash
pnpm dev
```

This command uses `concurrently` and `wait-on` to ensure:

1. `dtu-github-actions` (Mock Server) starts first on port 8910.
2. `bridge` waits for the mock server to be ready and starts on port 8911.
3. `cli` waits for the bridge to be ready.

Or target specific services:

```bash
pnpm --filter dtu-github-actions dev
pnpm --filter bridge dev
```

### Headless Mode (This Repository Only)

You can run workflows securely in headless mode without starting the full suite of services. _Note: Running external workflows is not yet supported or tested._

To run a specific workflow:

```bash
pnpm --filter cli run machinen run --workflow .github/workflows/tests.yml
```

To run all relevant PR/Push workflows for your current branch:

```bash
pnpm --filter cli run machinen run --all
```

---

## System Architecture

The system consists of three primary technical components:

1.  **Cloudflare Worker (Orchestrator):** The source of truth for runner availability. It queues jobs and manages "Heartbeats" from local nodes.
2.  **Local CLI (Agent):** A Node.js daemon running on your MacBook that polls for jobs and manages the Docker lifecycle.
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
          RESPONSE=$(curl -s https://machinen.redwoodjs.workers.dev/api/presence?username=${{ github.actor }})
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

Unlike GitHub-hosted `ubuntu-latest` runners that come pre-populated with gigabytes of tools (like Node.js, Python, Go, etc.), the `machinen` self-hosted runner starts with an empty cache.

This means the _very first time_ a workflow uses an action like `actions/setup-node`, it will need to download the tool from the internet, taking slightly longer. However, the downloaded tools are saved to a persistent `toolcache` directory on your host machine. All subsequent runs and containers will instantly mount and find the tools in the cache, skipping the download step.

---

## Workspace Copies (macOS)

On macOS, each run gets a private copy of the repository workspace placed under `$TMPDIR/machinen/<repo>/runs/<run-id>/`, where `<run-id>` follows the pattern `machinen-<N>` with optional suffixes:

| Suffix  | Meaning                           |
| ------- | --------------------------------- |
| `-j<N>` | Job index in a multi-job workflow |
| `-m<N>` | Matrix shard index                |
| `-r<N>` | Retry attempt                     |

For example: `machinen-42-j2-m3-r2` is the second retry of shard 3 of job 2 in run 42. In full service mode a repo slug is included: `machinen-<repo>-42-j1`. These copies are **APFS copy-on-write clones** made via `cp -c`, so they consume **zero additional disk space** at creation time — physical blocks are shared with the original files and only duplicated if the container modifies them.

On Linux, `rsync` is used instead, which produces regular copies. Linux supports CoW via `cp --reflink=auto` on btrfs and XFS (kernel 4.16+) — this could replace the rsync path to get the same benefit on supported filesystems, with automatic fallback to a full copy on ext4.
