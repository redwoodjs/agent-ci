# Engine

This engine indexes denormalized source documents stored in R2 and serves query endpoints. It uses:

- Cloudflare AI for embeddings and LLM calls
- Cloudflare Vectorize for vector search
- Durable Objects (SQLite) for indexing state and the Moment Graph

At a high level, the system maintains two stores:

1. **Evidence Locker**: a vector index of document chunks for semantic retrieval.
2. **Moment Graph**: a graph of moments for narrative queries. Root moments act as subjects and are indexed into a subject vector index.

See `docs/architecture/system-flow.md` for the end-to-end flow.

## Architecture

### Indexing pipeline

Given an R2 object key, indexing does the following:

1. Fetch the document from R2 and prepare it via a plugin.
2. Split the document into chunks and diff against previously processed chunk hashes.
3. Fan out new chunks to a chunk processing queue to insert vectors into the Evidence Locker.
4. Extract micro moments, synthesize macro moments, and update the Moment Graph. Root moments are indexed as subjects.

### Query pipeline

Queries use a subject-first path:

1. Embed the user query and query the subject index.
2. If a subject is found, traverse the Moment Graph to build a narrative timeline and ask the LLM for an answer.
3. If no subject path is available, fall back to chunk retrieval against the Evidence Locker.

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

### 1. Configure Vectorize Indexes

Create Vectorize indexes with the appropriate dimensions for your embedding model (default: @cf/baai/bge-base-en-v1.5, 768 dimensions).

**Evidence Locker index (raw content chunks):**
```bash
npx wrangler vectorize create rag-index \
  --dimensions=768 \
  --metric=cosine
```

**Moment Index (for moment summaries):**
```bash
npx wrangler vectorize create moment-index \
  --dimensions=768 \
  --metric=cosine
```

**Subject Index (for root moments representing Subjects):**
```bash
npx wrangler vectorize create subject-index \
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

Indexing is usually triggered by R2 event notifications. You can also trigger it manually by sending messages to the indexing queue or by calling admin endpoints.

#### Indexing via queue

Send a message to the indexing queue with the R2 key:

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

Queue message shapes are polymorphic:

- `r2Key` or `r2Keys` (at top-level or nested under `body`)
- optional `momentGraphNamespace` (or `namespace`) to scope the Moment Graph and indexing state for the job

### Manual Indexing via API

You can manually trigger indexing for a single file using the `/admin/index` endpoint:

```bash
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"r2Key": "discord/123456789/987654321/2024-11-04.jsonl"}' \
  "http://localhost:5173/admin/index"
```

Or use the full URL directly:
```bash
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"r2Key": "discord/123456789/987654321/2024-11-04.jsonl"}' \
  "https://your-domain.workers.dev/admin/index"
```

Or use `scripts/query.sh` to build the base URL from `MACHINEN_ENV`:

```bash
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"r2Key": "discord/123456789/987654321/2024-11-04.jsonl"}' \
  "$(./scripts/query.sh --env ${MACHINEN_ENV:-local} --dry-run-url)/admin/index"
```

**Response:**

```json
{
  "success": true,
  "message": "Enqueued file for indexing",
  "r2Key": "discord/123456789/987654321/2024-11-04.jsonl"
}
```

The indexing pipeline will:

1. Fetch the document from R2
2. Use plugins to prepare and chunk the document
3. Generate embeddings for each chunk
4. Insert chunk vectors into Vectorize (Evidence Locker)
5. Extract micro moments, synthesize macro moments, and update the Moment Graph

### Manual resync (inline or enqueue)

For local iteration, `/admin/resync` can run indexing inline (no queue wait) or enqueue it. It also accepts a namespace override so runs can be isolated without changing `.dev.vars`.

Inline:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"mode":"inline","momentGraphNamespace":"test-run-6","r2Keys":["cursor/conversations/<docA>/latest.json","cursor/conversations/<docB>/latest.json"]}' \
  "http://localhost:5173/admin/resync"
```

Enqueue:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"mode":"enqueue","momentGraphNamespace":"test-run-6","r2Keys":["cursor/conversations/<docA>/latest.json"]}' \
  "http://localhost:5173/admin/resync"
```

Or use `scripts/query.sh` to build the base URL from `MACHINEN_ENV`:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"mode":"inline","momentGraphNamespace":"test-run-6","r2Keys":["cursor/conversations/<docA>/latest.json","cursor/conversations/<docB>/latest.json"]}' \
  "$(./scripts/query.sh --env ${MACHINEN_ENV:-local} --dry-run-url)/admin/resync"
```

### Manual Backfill

To backfill all unprocessed or updated files for a specific prefix, use the `/admin/backfill` endpoint:

```bash
# Backfill GitHub files
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix": "github/"}' \
  "https://your-domain.workers.dev/admin/backfill"

# Backfill Cursor conversations
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix": "cursor/"}' \
  "https://your-domain.workers.dev/admin/backfill"

# Backfill Discord files
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix": "discord/"}' \
  "https://your-domain.workers.dev/admin/backfill"
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

Query via the `/query` endpoint. The `scripts/query.sh` script automatically uses your `MACHINEN_ENV` setting:

```bash
./scripts/query.sh "your query"
```

Or use curl directly:

**GET request:**

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://your-domain.workers.dev/query?q=your+query"
```

**POST request:**

```bash
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "your query"}' \
  "https://your-domain.workers.dev/query"
```

**Response:**

The endpoint returns plain text.

### Query response modes

`/query` accepts `responseMode` (`answer`, `brief`, `prompt`).

Example:

```bash
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "your query", "responseMode": "brief"}' \
  "https://your-domain.workers.dev/query"
```

Compatibility:

- (No `/rag/*` alias paths.)

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
- `VECTORIZE_INDEX`: Vectorize index binding for raw chunks (configured in wrangler.jsonc)
- `MOMENT_INDEX`: Vectorize index binding for moment summaries (configured in wrangler.jsonc)
- `SUBJECT_INDEX`: Vectorize index binding for root moments representing Subjects (configured in wrangler.jsonc)
- `AI`: Cloudflare AI binding (configured in wrangler.jsonc)
- `MOMENT_GRAPH_NAMESPACE`: prefixes the Durable Object database namespaces used by indexing state and the Moment Graph, and is written into Moment/Subject vector metadata for filtering

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
