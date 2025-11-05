# Cursor Ingestion

This ingestor captures Cursor conversation data via Cursor hooks and stores aggregated interactions in R2.

## Setup

### 1. Install the Cursor Hooks

Run the setup script to configure Cursor hooks:

```bash
./src/app/ingestors/cursor/scripts/setup.sh
```

This will:
- Copy the hook script to `~/.cursor/hooks/`
- Create/update `~/.cursor/hooks.json` to register the hooks
- Make the hook script executable

**Note:** You'll need to restart Cursor after running the setup script.

### 2. Configure API Key Authentication

The ingestion endpoint is protected by a general ingest API key (shared across all ingestion methods). You need to:

1. **Set the API key as a Cloudflare Worker secret:**

   For production:
   ```bash
   npx wrangler secret put INGEST_API_KEY
   ```

   For local development, add it to `.dev.vars`:
   ```
   INGEST_API_KEY=your-secret-api-key-here
   ```

2. **Set the API key environment variable for the hook script:**

   The hook script reads the API key from the `INGEST_API_KEY` environment variable. You can set this in your shell:

   ```bash
   export INGEST_API_KEY=your-secret-api-key-here
   ```

   Or add it to your shell profile (e.g., `~/.zshrc` or `~/.bashrc`) to make it persistent.

3. **Optionally configure the endpoint URL:**

   By default, the hook script sends data to the production endpoint `https://machinen.workers.dev/ingestors/cursor`. To override this (e.g., for local development), set the `CURSOR_INGEST_URL` environment variable:

   ```bash
   # For local development
   export CURSOR_INGEST_URL=http://localhost:5173/ingestors/cursor
   
   # Or for a custom domain
   export CURSOR_INGEST_URL=https://your-domain.com/ingestors/cursor
   ```

## How It Works

1. Cursor hooks trigger the hook script (`hook.sh`) at various stages of the agent loop
2. The hook script sends event data to the ingestion endpoint with API key authentication
3. Events are aggregated by `generation_id` in a SQLite Durable Object
4. When a `stop` event is received, all events for that generation are:
   - Aggregated into a single JSON document
   - Stored in R2 at `cursor-conversations/{conversation_id}/{generation_id}.json`
   - Removed from the Durable Object

## Testing

You can test the ingestion flow using the test route:

```bash
curl http://localhost:5173/ingestors/cursor/test
```

This will create a sample conversation and store it in R2.

