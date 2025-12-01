# RAG Engine

The RAG (Retrieval-Augmented Generation) engine provides a plugin-based architecture for indexing and querying documents. It uses Cloudflare Vectorize for vector storage and Cloudflare AI for embeddings and LLM generation.

## Architecture

The engine operates in two main pipelines:

1. **Indexing Pipeline**: Processes documents from R2, chunks them, generates embeddings, and stores them in Vectorize
2. **Query Pipeline**: Takes user queries, performs vector search, reconstructs context, and generates LLM responses

See the [worklog](../.notes/justin/worklogs/2025-11-09-rag-engine-poc-design.md) for detailed architecture documentation.

## Setup

### 0. Development Environments

By default, all scripts and commands target production. To use a personal development environment:

1. **Set `CLOUDFLARE_ENV` in `.dev.vars` for deployment:**
   ```bash
   CLOUDFLARE_ENV="dev-justin"
   ```

2. **Set `MACHINEN_ENV` in `.dev.vars` for scripts:**
   ```bash
   MACHINEN_ENV="dev-justin"
   ```

3. **Deploy to your personal environment:**
   ```bash
   pnpm release
   # Uses CLOUDFLARE_ENV from .dev.vars
   ```

4. **Query your environment:**
   ```bash
   ./scripts/query.sh "your query"
   # Automatically uses the environment from MACHINEN_ENV
   ```

**Supported values:**
- `CLOUDFLARE_ENV`: Matches environment names in `wrangler.jsonc` (e.g., `dev-justin`, `production`)
- `MACHINEN_ENV`: `local` (default, targets localhost), `dev-<name>`, or `production`

**R2 Event Fan-out:** Configure the production R2 bucket to send event notifications to all developer environments. This allows each developer's staging environment to receive live data for end-to-end testing.

See `docs/dx/environments.md` for detailed information on the multi-environment setup.

### 1. Configure Vectorize Index

Create a Vectorize index with the appropriate dimensions for your embedding model:

```bash
npx wrangler vectorize create rag-index \
  --dimensions=768 \
  --metric=cosine
```

The default embedding model (`@cf/baai/bge-base-en-v1.5`) uses 768 dimensions. Update `wrangler.jsonc` if you use a different model.

### 2. Configure API Key

Set the `API_KEY` environment variable for query and admin endpoint authentication:

**For local development (in `.dev.vars`):**

```bash
API_KEY=your_secret_here
```

**For production:**

```bash
wrangler secret put API_KEY
# Then paste your secret when prompted
```

### 3. Create Indexing Queue

Create the queue for indexing jobs:

**For production:**

```bash
npx wrangler queues create engine-indexing-queue-prod
```

**For test environment:**

```bash
npx wrangler queues create engine-indexing-queue
```

Verify it exists:

```bash
wrangler queues list
```

### 4. Configure R2 Bucket

Ensure your `MACHINEN_BUCKET` R2 binding is configured in `wrangler.jsonc`. The engine expects source documents to be stored in R2 with paths like:

- `github/{owner}/{repo}/pull-requests/{number}/latest.json`
- `github/{owner}/{repo}/issues/{number}/latest.json`
- `github/{owner}/projects/{number}/latest.json`
- `discord/{guildID}/{channelID}/{YYYY-MM-DD}.jsonl` (channel messages)
- `discord/{guildID}/{channelID}/threads/{threadID}/latest.json` (thread messages)
- `cursor/conversations/{conversation_id}/latest.json`

### 5. Configure R2 Event Notifications

To enable automatic indexing when files are created or updated in R2, configure event notifications.

**Why two rules?**

The worker processes two file patterns:
- Files ending with `latest.json` → GitHub (PRs, Issues, Projects), Cursor (conversations), Discord threads
- Files starting with `discord/` and ending with `.jsonl` → Discord channel messages

Since R2 notifications can only match one suffix pattern per rule, we need two separate rules to cover both patterns.

**For production:**

```bash
# Required: For latest.json files (covers GitHub, Cursor, Discord threads)
npx wrangler r2 bucket notification create machinen \
  --queue r2-file-update-queue-prod \
  --event-type object-create \
  --suffix latest.json

# Optional: Only needed if you're ingesting Discord channel messages (.jsonl files)
npx wrangler r2 bucket notification create machinen \
  --queue r2-file-update-queue-prod \
  --event-type object-create \
  --prefix discord/ \
  --suffix .jsonl
```

**For test environment:**

```bash
# Required: For latest.json files (covers GitHub, Cursor, Discord threads)
npx wrangler r2 bucket notification create machinen \
  --queue r2-file-update-queue \
  --event-type object-create \
  --suffix latest.json

# Optional: Only needed if you're ingesting Discord channel messages (.jsonl files)
npx wrangler r2 bucket notification create machinen \
  --queue r2-file-update-queue \
  --event-type object-create \
  --prefix discord/ \
  --suffix .jsonl
```

**How it works:**

- When a file matching these patterns is created or updated in R2, a message is sent to the queue
- The worker filters events and only processes files that match expected patterns:
  - Files ending with `latest.json` (GitHub, Cursor, Discord threads)
  - Files starting with `discord/` and ending with `.jsonl` (Discord channel messages)
- The worker then enqueues matching files to the indexing queue

**Note**: If event notifications aren't configured, you can still use the manual backfill endpoint (see "Manual Backfill" section below) to index files.

## Usage

### Indexing Documents

To index a document, send a message to the `engine-indexing-queue` with the R2 key:

```typescript
// GitHub example
await env.ENGINE_INDEXING_QUEUE.send({
  r2Key: "github/owner/repo/pull-requests/123/latest.json",
});

// Discord example (channel messages)
await env.ENGINE_INDEXING_QUEUE.send({
  r2Key: "discord/123456789/987654321/2024-11-04.jsonl",
});

// Discord example (thread)
await env.ENGINE_INDEXING_QUEUE.send({
  r2Key: "discord/123456789/987654321/threads/111222333/latest.json",
});
```

**Note**: Documents are automatically indexed when created or updated in R2 via R2 event notifications. Manual indexing is typically only needed for backfilling or re-indexing.

### Manual Indexing via API

You can manually trigger indexing for a single file using the `/admin/index` endpoint:

```bash
# Uses the environment from MACHINEN_ENV (or defaults to local)
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"r2Key": "discord/123456789/987654321/2024-11-04.jsonl"}' \
  "$(./scripts/query.sh --env ${MACHINEN_ENV:-local} --dry-run-url)/rag/admin/index"
```

Or use the full URL directly:
```bash
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"r2Key": "discord/123456789/987654321/2024-11-04.jsonl"}' \
  "https://your-domain.workers.dev/rag/admin/index"
```

**Response:**

```json
{
  "success": true,
  "message": "Enqueued file for indexing",
  "r2Key": "discord/123456789/987654321/2024-11-04.jsonl"
}
```

The indexing worker will:

1. Fetch the document from R2
2. Use plugins to prepare and chunk the document
3. Generate embeddings for each chunk
4. Delete any existing vectors for that document
5. Insert new vectors into Vectorize

### Manual Backfill

To backfill all unprocessed or updated files for a specific prefix, use the `/admin/backfill` endpoint:

```bash
# Backfill GitHub files
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix": "github/"}' \
  "https://your-domain.workers.dev/rag/admin/backfill"

# Backfill Cursor conversations
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix": "cursor/"}' \
  "https://your-domain.workers.dev/rag/admin/backfill"

# Backfill Discord files
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix": "discord/"}' \
  "https://your-domain.workers.dev/rag/admin/backfill"
```

**Response:**

```json
{
  "success": true,
  "message": "Backfill completed. Enqueued 42 files for indexing.",
  "filesEnqueued": 42
}
```

The backfill process:

1. Scans all files in R2 matching the prefix
2. Compares each file's ETag with the stored state in the indexing database
3. Only enqueues files that:
   - Have never been indexed, or
   - Have been updated since last indexing (ETag mismatch)
4. Is idempotent and safe to run multiple times

### Querying

Query the RAG engine via the `/rag/query` endpoint. The `scripts/query.sh` script automatically uses your `MACHINEN_ENV` setting:

```bash
./scripts/query.sh "your query"
```

Or use curl directly:

**GET request:**

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://your-domain.workers.dev/rag/query?q=your+query"
```

**POST request:**

```bash
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "your query"}' \
  "https://your-domain.workers.dev/rag/query"
```

**Response:**

```json
{
  "response": "LLM-generated answer based on retrieved context"
}
```

## API Protection

The query endpoint is protected by:

1. **API Key Authentication**: Requires `Authorization: Bearer <API_KEY>` header
2. **Rate Limiting**: 20 requests per minute per API key
3. **Input Validation**: Query must be 3-1000 characters

## Plugins

Plugins extend the engine's functionality for different data sources. Currently implemented:

- **GitHub Plugin** (`plugins/github.ts`): Handles GitHub PRs, Issues, and Projects
- **Discord Plugin** (`plugins/discord.ts`): Handles Discord channel messages (JSONL) and thread conversations (JSON)
- **Cursor Plugin** (`plugins/cursor.ts`): Handles Cursor conversation data

Plugins implement hooks for:

- `prepareSourceDocument`: Converts R2 data into a `Document`
- `splitDocumentIntoChunks`: Splits documents into chunks with metadata
- `reconstructContext`: Formats document context for LLM prompts
- `composeLlmPrompt`: Aggregates context from multiple sources

See `types.ts` for the complete plugin interface.

## Environment Variables

- `API_KEY`: API key for query and admin endpoint authentication
- `MACHINEN_BUCKET`: R2 bucket binding (configured in wrangler.jsonc)
- `VECTORIZE_INDEX`: Vectorize index binding (configured in wrangler.jsonc)
- `AI`: Cloudflare AI binding (configured in wrangler.jsonc)

## Queue Configuration

The indexing queue is configured in `wrangler.jsonc`:

```jsonc
{
  "queues": {
    "producers": [
      {
        "queue": "engine-indexing-queue-prod",
        "binding": "ENGINE_INDEXING_QUEUE"
      }
    ],
    "consumers": [
      {
        "queue": "engine-indexing-queue-prod",
        "max_batch_size": 10,
        "max_batch_timeout": 30
      }
    ]
  }
}
```
