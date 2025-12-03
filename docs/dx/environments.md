# Development Environments

This document describes the multi-environment development setup for Machinen. This allows each developer to have a personal, cloud-deployed staging environment that can receive live R2 bucket events, solving the limitations of a local-only development setup.

For environment-specific setup instructions, see:
- [Engine README](../../src/app/engine/README.md) - RAG engine setup and usage
- [GitHub Ingestor README](../../src/app/ingestors/github/README.md) - GitHub webhook and backfill setup
- [Discord Ingestor README](../../src/app/ingestors/discord/README.md) - Discord backfill setup
- [Cursor Ingestor README](../../src/app/ingestors/cursor/README.md) - Cursor hook setup

## 1. `wrangler.jsonc` Environments

We use Wrangler's built-in environments feature to manage configurations for different deployments. Each environment can have a unique worker name.

```jsonc:wrangler.jsonc
// ... base config for local dev ...

[env.dev-justin]
name = "machinen-dev-justin"

[env.production]
name = "machinen"
```

To add a new developer, simply add a new `[env.dev-yourname]` section.

## 2. The `MACHINEN_ENV` Convention (for Scripts)

Local scripts (like `query.sh`) use `MACHINEN_ENV` to determine which worker URL to target.

- **Set it in `.dev.vars`:**
  ```.dev.vars
  MACHINEN_ENV="dev-justin"
  ```
- **Supported Values:**
  - `local`: (Default) Targets `http://localhost:8787`. Used by `npm run dev`.
  - `dev-<name>`: Targets your personal staging worker (e.g., `dev-justin`).
  - `production`: Targets the production worker.

## 3. The `CLOUDFLARE_ENV` Convention (for Deployment)

Deployment targets are controlled by the `CLOUDFLARE_ENV` environment variable, which is used by Cloudflare's RedwoodSDK plugin.

- **Set it in `.dev.vars`:** This is the primary way to set your default target environment.
  ```.dev.vars
  CLOUDFLARE_ENV="dev-justin"
  ```
- **Supported Values:** Match the environment names in `wrangler.jsonc`:
  - `dev-justin`: Targets your personal staging worker
  - `production`: Targets the production worker
  - (omitted): Uses default/base configuration

## 4. How to Deploy

The `release` script in `package.json` uses `CLOUDFLARE_ENV` to target a specific environment defined in `wrangler.jsonc`.

- **Deploy to your personal environment:**
  ```bash
  # Set in .dev.vars: CLOUDFLARE_ENV="dev-justin"
  pnpm release
  ```

- **Deploy to production:**
  ```bash
  # Set in .dev.vars: CLOUDFLARE_ENV="production"
  pnpm release
  ```
  *(Note: This should be done with care, likely via a CI/CD pipeline in the future).*

- **Override for one-off deployments:**
  ```bash
  CLOUDFLARE_ENV="dev-justin" pnpm release
  ```

## 5. How to Query

The `scripts/query.sh` script now automatically targets the environment specified by `MACHINEN_ENV`.

- **Query your default environment (from `.dev.vars`):**
  ```bash
  ./scripts/query.sh "what is the status of the RAG engine?"
  # Output will show:
  # Querying environment: dev-justin (https://machinen-dev-justin.redwoodjs.workers.dev)
  # Query: what is the status of the RAG engine?
  ```

- **Temporarily query another environment:**
  You can override the default with the `--env` flag.
  ```bash
  ./scripts/query.sh --env production "is the system stable?"
  # Output will show:
  # Querying environment: production (https://machinen.redwoodjs.workers.dev)
  # Query: is the system stable?
  ```

## 6. R2 Event Notifications (Fan-out)

The final piece is to configure the production R2 bucket to send event notifications to **all** active developer environments.

- **Action:** In the Cloudflare Dashboard, under the R2 bucket's settings, add a new event notification for each developer's worker URL (e.g., `https://machinen-dev-justin.redwoodjs.workers.dev`).
- **Result:** When a file is uploaded to the production bucket, it will trigger the indexing pipeline on your personal worker, allowing for end-to-end testing with live data.
