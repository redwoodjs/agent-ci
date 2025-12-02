# Machinen, by RedwoodSDK

![Machinen Logo](./logo.svg)

## What is Machinen?

Machinen is a platform for ingesting, indexing, and querying data from various sources (GitHub, Cursor, Discord) using a RAG (Retrieval-Augmented Generation) engine built with RedwoodSDK and Cloudflare Workers.

## Quickstart

Install dependencies and start the development server:

```bash
pnpm install
pnpm dev
```

## Common Setup

### Environment Variables

Create a `.dev.vars` file in the project root. See each component's README for specific variables needed:

- `INGEST_API_KEY`: Used by GitHub and Cursor ingestors
- `API_KEY`: Used by RAG engine query and admin endpoints
- `GITHUB_TOKEN`: Used by GitHub ingestor for backfilling
- `DISCORD_BOT_TOKEN`: Used by Discord ingestor

For production, set these as Cloudflare Worker secrets:

```bash
wrangler secret put INGEST_API_KEY
wrangler secret put API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put DISCORD_BOT_TOKEN
```

### R2 Buckets

Ensure your R2 buckets are configured in `wrangler.jsonc`. The following bindings are required:

- `MACHINEN_BUCKET`: Main storage bucket for ingested data

### Cloudflare Queues

Multiple components require Cloudflare Queues. Create queues as needed:

**Production:**

```bash
# GitHub ingestor queues
npx wrangler queues create github-scheduler-queue-prod
npx wrangler queues create github-processor-queue-prod
npx wrangler queues create github-processor-queue-prod-dlq

# RAG engine indexing queue
npx wrangler queues create engine-indexing-queue-prod
```

**Test environment:**

```bash
# GitHub ingestor queues
npx wrangler queues create github-scheduler-queue
npx wrangler queues create github-processor-queue
npx wrangler queues create github-processor-queue-dlq

# RAG engine indexing queue
npx wrangler queues create engine-indexing-queue
```

Verify queues exist:

```bash
wrangler queues list
```

## Components

### Ingestors

- **[GitHub Ingestor](./src/app/ingestors/github/README.md)**: Ingests issues, pull requests, comments, releases, and projects from GitHub
- **[Cursor Ingestor](./src/app/ingestors/cursor/README.md)**: Captures Cursor conversation data via hooks and provides MCP server for knowledge base integration. Setup: `./scripts/setup-cursor.sh`
- **[Discord Ingestor](./src/app/ingestors/discord/README.md)**: Fetches Discord messages and stores them in JSONL format

### RAG Engine

- **[RAG Engine](./src/app/engine/README.md)**: Plugin-based architecture for indexing and querying documents using Vectorize and Cloudflare AI

### Query Script

The `scripts/query.sh` script provides a convenient way to query the RAG engine from the command line.

**Basic Usage:**

```bash
./scripts/query.sh "your query here"
```

**With Local Development Server:**

```bash
# Using port shorthand
WORKER_URL=':5173' ./scripts/query.sh "your query"

# Using full localhost URL
./scripts/query.sh "your query" "http://localhost:5173"
```

**Environment Variables:**

The script automatically reads `API_KEY` from `.dev.vars` if present. You can also override it:

```bash
# Via environment variable
API_KEY="your-key" ./scripts/query.sh "your query"

# Via command line argument
./scripts/query.sh "your query" "your-api-key"
```

**URL Shorthand:**

The script supports shorthand formats for the worker URL:

- `:5173` → `http://localhost:5173`
- `localhost:5173` → `http://localhost:5173`
- Full URLs work as-is: `https://machinen.redwoodjs.workers.dev`

**Error Handling:**

If the API response cannot be parsed (e.g., authentication errors), the script will display the raw JSON response instead of silently returning null.

## Documentation

- [Architecture: RAG Engine](./docs/architecture/rag-engine.md)
- [Architecture: GitHub Ingestion Pipeline](./docs/architecture/github-ingestion-pipeline.md)
- [RAG Engine Design Worklog](./.notes/justin/worklogs/2025-11-09-rag-engine-poc-design.md)
