# Cursor Ingestion

This ingestor captures Cursor conversation data via Cursor hooks and stores aggregated interactions in R2.

## Setup

### Quick Start

Add `INGEST_API_KEY` to your shell profile, then run the setup script:

**zsh:**
```bash
echo 'export INGEST_API_KEY=your-secret-api-key-here' >> ~/.zshrc && source ~/.zshrc && ./src/app/ingestors/cursor/scripts/setup.sh
```

**bash:**
```bash
echo 'export INGEST_API_KEY=your-secret-api-key-here' >> ~/.bashrc && source ~/.bashrc && ./src/app/ingestors/cursor/scripts/setup.sh
```

**fish:**
```fish
echo 'set -gx INGEST_API_KEY your-secret-api-key-here' >> ~/.config/fish/config.fish && source ~/.config/fish/config.fish && bash ./src/app/ingestors/cursor/scripts/setup.sh
```

By default, the hook sends data to `https://machinen.redwoodjs.workers.dev/ingestors/cursor`. To change this, set `CURSOR_INGEST_URL` in your shell profile (e.g., `export CURSOR_INGEST_URL=http://localhost:5173/ingestors/cursor`).

Restart Cursor after running the setup script.

### Use Cases

#### Getting it working on your machine

If you're using the existing production deployment, just follow the Quick Start above. The hook will send data to `https://machinen.redwoodjs.workers.dev/ingestors/cursor` by default.

#### Setting up a new deployment

For a new application or to change the API key:

1. **Set the API key in your Cloudflare Worker:**

   Add it to `.dev.vars` for local development:
   ```
   INGEST_API_KEY=your-secret-api-key-here
   ```

   Set it as a Cloudflare Worker secret for production:
   ```bash
   npx wrangler secret put INGEST_API_KEY
   ```

2. **Change the endpoint URL:**

   Set `CURSOR_INGEST_URL` in your shell profile to point to your deployment:
   ```bash
   export CURSOR_INGEST_URL=https://your-domain.com/ingestors/cursor
   ```

## Knowledge Base Integration (MCP)

You can also connect Cursor to the Machinen knowledge base to get relevant context while you chat. This uses the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

1. Go to **Cursor Settings** -> **Features** -> **MCP Servers**.
2. Click **+ Add New MCP Server**.
3. Enter the following details:
   - **Name**: `machinen`
   - **Type**: `stdio`
   - **Command**: `node /absolute/path/to/machinen/scripts/mcp-server.ts`
     *(Note: You must use the absolute path to the repo on your machine)*
   - **Environment Variables**:
     - `MACHINEN_API_KEY`: `your-secret-api-key`
     - `MACHINEN_API_URL`: `https://machinen.redwoodjs.workers.dev` (optional, defaults to production)

Once connected, the AI will automatically search the knowledge base when you ask questions about project history or architecture.

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
