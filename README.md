# Machinen

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

## Run Locally

```bash
pnpm machinen-dev run --workflow .github/workflows/tests.yml
```

To run all relevant PR/Push workflows for your current branch:

```bash
pnpm machinen-dev run --all
```

A workflow is **relevant** if its `on:` trigger includes:

- **`pull_request`** — targeting `main` (respecting `branches` / `branches-ignore` filters)
- **`push`** — matching the current branch (respecting `branches` / `branches-ignore` filters)

Workflows triggered only by `schedule`, `workflow_dispatch`, `release`, etc. are skipped.
