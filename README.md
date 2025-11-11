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
- `MACHINEN_CONTEXT_STREAM_BUCKET`: Context stream bucket

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
- **[Cursor Ingestor](./src/app/ingestors/cursor/README.md)**: Captures Cursor conversation data via hooks
- **[Discord Ingestor](./src/app/ingestors/discord/README.md)**: Fetches Discord messages and stores them in JSONL format

### RAG Engine

- **[RAG Engine](./src/app/engine/README.md)**: Plugin-based architecture for indexing and querying documents using Vectorize and Cloudflare AI

## Documentation

- [Architecture: RAG Engine](./docs/architecture/rag-engine.md)
- [Architecture: GitHub Ingestion Pipeline](./docs/architecture/github-ingestion-pipeline.md)
- [Architecture: Sources-Artifacts-Subjects](./docs/architecture/sources-artifacts-subjects.md)
- [RAG Engine Design Worklog](./.notes/justin/worklogs/2025-11-09-rag-engine-poc-design.md)

## Licensing

This is released under the FSL license.
