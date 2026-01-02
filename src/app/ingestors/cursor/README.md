# Cursor Ingestion

This ingestor captures Cursor conversation data via Cursor hooks and stores aggregated interactions in R2.

## Setup

### Quick Start

Add `INGEST_API_KEY` to your shell profile, then run the setup script:

**zsh:**
```bash
echo 'export INGEST_API_KEY=your-secret-api-key-here' >> ~/.zshrc && source ~/.zshrc && ./scripts/setup-cursor.sh
```

**bash:**
```bash
echo 'export INGEST_API_KEY=your-secret-api-key-here' >> ~/.bashrc && source ~/.bashrc && ./scripts/setup-cursor.sh
```

**fish:**
```fish
echo 'set -gx INGEST_API_KEY your-secret-api-key-here' >> ~/.config/fish/config.fish && source ~/.config/fish/config.fish && bash ./scripts/setup-cursor.sh
```

By default, the hook sends data to `https://machinen.redwoodjs.workers.dev/ingestors/cursor` (production). To change this, set `CURSOR_INGEST_URL` in your shell profile.

**For local development:**
```bash
export CURSOR_INGEST_URL=http://localhost:5173/ingestors/cursor
```

**For a personal development environment:**
```bash
export CURSOR_INGEST_URL=https://machinen-dev-justin.redwoodjs.workers.dev/ingestors/cursor
```

Restart Cursor after running the setup script.

### Use Cases

#### Getting it working on your machine

If you're using the existing production deployment, just follow the Quick Start above. The hook will send data to `https://machinen.redwoodjs.workers.dev/ingestors/cursor` by default.

#### Setting up a personal development environment

1. **Set the API key in your Cloudflare Worker:**

   Add it to `.dev.vars` for local development:
   ```
   INGEST_API_KEY=your-secret-api-key-here
   ```

   Set it as a Cloudflare Worker secret for your dev environment:
   ```bash
   npx wrangler secret put INGEST_API_KEY --env dev-justin
   ```

2. **Change the endpoint URL:**

   Set `CURSOR_INGEST_URL` in your shell profile to point to your deployment:
   ```bash
   export CURSOR_INGEST_URL=https://machinen-dev-justin.redwoodjs.workers.dev/ingestors/cursor
   ```

See the [Engine README](../engine/README.md) for information on the multi-environment setup.

## Knowledge Base Integration (MCP)

You can also connect Cursor to the Machinen knowledge base to get relevant context while you chat. This uses the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

The setup script automatically builds and installs the MCP server and creates the MCP configuration file.

**Setup:**

1. Run the setup script:
   ```bash
   ./scripts/setup-cursor.sh
   ```

2. Set the `MACHINEN_API_KEY` environment variable:
   ```bash
   export MACHINEN_API_KEY='your-api-key-here'
   ```
   
   Or add it to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) for persistence.

3. Restart Cursor to load the MCP server.

**Manual Setup** (if needed):

1. Build the MCP server:
   ```bash
   npm run build:mcp-server
   ```

2. Copy the server to the hooks directory:
   ```bash
   cp dist/cursor/mcp-server.mjs ~/.cursor/hooks/machinen-mcp-server.mjs
   ```

3. Create `~/.cursor/mcp.json` in your home directory:
   ```json
   {
     "mcpServers": {
       "machinen": {
         "type": "stdio",
         "command": "node",
         "args": ["${userHome}/.cursor/hooks/machinen-mcp-server.mjs"],
         "env": {
           "MACHINEN_API_KEY": "${env:MACHINEN_API_KEY}",
           "MACHINEN_API_URL": "https://machinen.redwoodjs.workers.dev"
         }
       }
     }
   }
   ```

Once connected, the AI will automatically search the knowledge base when you ask questions about project history or architecture.

## Machinen (VS Code Extension)

There is also a companion **[VS Code Extension](../../../../vscode-extension/README.md)** that shows a pop-over when hovering over `//?` in your code. This can be used to display information retrieved from the Machinen knowledge base directly in your editor.

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
