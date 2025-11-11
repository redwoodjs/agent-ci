# RAG Engine

The RAG (Retrieval-Augmented Generation) engine provides a plugin-based architecture for indexing and querying documents. It uses Cloudflare Vectorize for vector storage and Cloudflare AI for embeddings and LLM generation.

## Architecture

The engine operates in two main pipelines:

1. **Indexing Pipeline**: Processes documents from R2, chunks them, generates embeddings, and stores them in Vectorize
2. **Query Pipeline**: Takes user queries, performs vector search, reconstructs context, and generates LLM responses

See the [worklog](../.notes/justin/worklogs/2025-11-09-rag-engine-poc-design.md) for detailed architecture documentation.

## Setup

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

## Usage

### Indexing Documents

To index a document, send a message to the `engine-indexing-queue` with the R2 key:

```typescript
await env.ENGINE_INDEXING_QUEUE.send({
  r2Key: "github/owner/repo/pull-requests/123/latest.json"
});
```

The indexing worker will:
1. Fetch the document from R2
2. Use plugins to prepare and chunk the document
3. Generate embeddings for each chunk
4. Delete any existing vectors for that document
5. Insert new vectors into Vectorize

### Querying

Query the RAG engine via the `/rag/query` endpoint:

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

