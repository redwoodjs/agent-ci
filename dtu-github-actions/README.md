# Digital Twin Universe (DTU) - GitHub Actions

This is a TypeScript package that provides tools and mocks to simulate GitHub Actions workflows locally.

## Purpose

The DTU allows developers to run and test the `bridge` and `cli` integration without deploying to GitHub. It mirrors GitHub's REST API and handles webhook simulation.

## Setup

This package is part of a `pnpm` workspace.

1.  **Environment Variables**:
    Symlinked to the root `.env`.

## Usage

From the project root:

1.  **Start the Mock Server**:
    ```bash
    pnpm --filter dtu/github-actions dev
    ```
2.  **Run Simulation**:
    ```bash
    pnpm --filter dtu/github-actions simulate <event_name>
    ```
    (e.g., `pnpm --filter dtu/github-actions simulate push`)

## Structure

- `src/`:
  - `config.ts`: Zod-based configuration.
  - `server.ts`: Mock GitHub API server.
  - `simulate.ts`: Webhook simulation script.
- `events/`: Mock GitHub JSON payloads.
