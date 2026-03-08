# CLI

The **CLI** is a Node.js daemon that executes on your local machine. It manages Docker containers to execute GitHub Actions.

## Features

- **Docker Integration**: Spawns isolated containers for job execution.
- **Freeze on Failure**: Keeps containers alive if a step fails for easy debugging.

## Development

This package is part of a `pnpm` workspace.

**Run Locally** from the project root:

```bash
pnpm --filter cli dev
```

## Configuration

All configuration is derived automatically at boot:

- **`GITHUB_REPO`**: Detected from `git remote get-url origin`.
- **`GITHUB_API_URL`**: The DTU mock server is started ephemerally per run.

No `.env` file is required.
