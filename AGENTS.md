# AGENTS.md

> [!NOTE]
> This file provides context and instructions for AI coding assistants (like Antigravity, Cursor, etc.) to ensure high-quality and consistent contributions.

## Project Overview

**Machinen** is a local-first CI runner system. It allows GitHub Actions to execute on your own hardware while providing a seamless fallback to GitHub-hosted runners.

### Core Philosophy: Freeze on Failure

Unlike ephemeral runners, this system is designed to **freeze on failure**. When a job fails, the Docker container and local filesystem should be preserved for interactive debugging. This must be maintained in all runner-related logic.

## Technical Stack

- **Runtimes**: Node.js (Supervisor/DTU), Cloudflare Workers (Bridge)
- **Language**: TypeScript (using `tsgo` for fast type checking)
- **Formatting**: `oxfmt`
- **Linting**: `oxlint`
- **Package Manager**: `pnpm` (Workspace)

## Project Structure

- [bridge](./bridge): Cloudflare Worker (Orchestrator). Source of truth for runner availability.
- [supervisor](./supervisor): Node.js daemon. Polls bridge and manages Docker lifecycle.
- [dtu-github-actions](./dtu-github-actions): Digital Twin Universe mock tools for local simulation.

## Common Commands

- `pnpm install`: Install dependencies.
- `pnpm dev`: Start all services (DTU, Bridge, Supervisor) concurrently.
- `pnpm check`: Run `typecheck`, `lint`, and `format:check`.
- `pnpm check:fix`: Run all checks and apply automatic fixes.
- `pnpm lint:fix`: Run `oxlint --fix`.
- `pnpm format:fix`: Run `oxfmt`.

## Guidelines for Agents

Be concise. Use TLDR. Never assume. Always provide the reasons why; and cite examples.

1. **Use Workspace Filters**:
   1.1 When working on specific components, use `--filter` (e.g., `pnpm --filter supervisor test`).
2. **Standard Tools**:
   2.1 Always use `oxlint` and `oxfmt`. Do not introduce ESLint or Prettier unless explicitly requested.
   2.2 Always use `tsgo` for type checking.
3. **Environment**:
   3.1 Use root-level `.env` for shared configuration. Services link to this file.
   3.2 Always use a secrets.md file; which parses `process.env` at the start of the script. This provides typesafe environment variables.
4. **Task Management**:
   4.1 Follow the workflows in `.agent/workflows/` (`tasks.md`, `worklog.md`).
   4.2 Always write tests. Do not modify tests unless explicitly requested.
