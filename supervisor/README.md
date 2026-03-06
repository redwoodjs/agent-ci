# Supervisor

The **Supervisor** is a Node.js daemon that executes on your local machine. It manages Docker containers to execute GitHub Actions.

## Features

- **Docker Integration**: Spawns isolated containers for job execution.
- **Freeze on Failure**: Keeps containers alive if a step fails for easy debugging.

## Development

This package is part of a `pnpm` workspace.

1. **Environment Variables**:
   Symlinked to the root `.env`. Ensure the root `.env` is configured.

2. **Run Locally**:
   From the project root:
   ```bash
   pnpm --filter supervisor dev
   ```

## Configuration

The supervisor relies on:

- `GITHUB_USERNAME`: Your GitHub username for identifying assigned jobs.

## Future

We will enable authentication via GitHub for your personal account.
