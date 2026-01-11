# Local Development with Durable Objects

When developing locally, you need to populate your local Durable Objects with data. Unlike R2 buckets and Vectorize indexes, Durable Objects **cannot** be configured with `remote: true` to connect directly to production.

## Solution: Local Copy via Re-indexing

The only way to get production data into your local Durable Objects is to re-populate them by re-indexing remote R2 documents. This creates a local clone of the production state.

Re-populate your local Durable Objects by re-indexing remote R2 documents. This creates a local clone of the production state without connecting to production DOs.

### Setup

1. Start your local development server:

```bash
pnpm dev
```

### Usage

#### Full Backfill

Use the provided backfill script to sync all data for a prefix:

```bash
# Backfill all GitHub data
./scripts/local-backfill.sh github/

# Backfill all Discord data
./scripts/local-backfill.sh discord/

# Backfill all Cursor conversations
./scripts/local-backfill.sh cursor/
```

#### Small Sample (Recommended for Local Development)

For faster local development, you can backfill just a small sample:

```bash
# Use manual-index to select specific files, then use --keys
./scripts/manual-index.mjs github/
# (Select files, then use the R2 keys shown)

# Or specify exact R2 keys directly
./scripts/local-backfill.sh --keys \
  github/owner/repo/pull-requests/123/latest.json,\
  github/owner/repo/issues/456/latest.json
```

#### Target Specific Code Locations (TL;DR Semantics)

To index documents related to a specific code location, use the same semantics as the TL;DR feature. The format matches the URL parameters used in the web UI:

```bash
# Index PRs related to a specific commit and file location
# Format: --code REPO COMMIT FILE:LINE
./scripts/local-backfill.sh --code redwoodjs/sdk e4d0403 navigationCache.ts:380

# With optional namespace (matches web UI format)
./scripts/local-backfill.sh --code redwoodjs/sdk e4d0403 navigationCache.ts:380 \
  --namespace prod-2025-01-09-00-30:redwood:rwsdk
```

This matches the URL format used in the web UI:

```
http://localhost:5173/audit/tldr/?repo=redwoodjs/sdk&commit=e4d0403&file=navigationCache.ts:380&namespace=prod-2025-01-09-00-30:redwood:rwsdk
```

The script will:

1. Parse the `file:line` format (using the last colon as separator, like the web UI)
2. Find all pull requests that include the specified commit
3. Construct R2 keys for those PRs (e.g., `github/redwoodjs/sdk/pull-requests/123/latest.json`)
4. Index those PR documents locally using the specified namespace

**Note:** Requires `GITHUB_TOKEN` to be set in `.dev.vars` for GitHub API access.

Or use curl directly:

```bash
# Get your API key
API_KEY=$(grep API_KEY .dev.vars | cut -d= -f2 | tr -d '"')

# Backfill GitHub
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix": "github/"}' \
  "http://localhost:5173/admin/backfill"

# Backfill Discord
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix": "discord/"}' \
  "http://localhost:5173/admin/backfill"

# Backfill Cursor
curl -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix": "cursor/"}' \
  "http://localhost:5173/admin/backfill"
```

### Selective Indexing

For faster iteration on specific files, use the manual indexing script:

```bash
WORKER_URL='http://localhost:5173' ./scripts/manual-index.mjs "github/owner/repo/"
```

This will:

1. List files from your remote R2 bucket matching the prefix
2. Let you select which files to index
3. Trigger local indexing for the selected files

### How It Works

1. Your local worker reads documents from the **remote** R2 bucket (configured with `remote: true` in `wrangler.jsonc`)
2. The worker processes each document locally
3. Results are stored in your **local** Durable Object SQLite databases (in `.wrangler` or `.cache` directory)
4. Your local code can now query this local data

### Benefits

- **Safe**: No risk of modifying production data
- **Isolated**: Your local changes don't affect production
- **Selective**: You can choose which data to sync
- **Fast iteration**: Re-index only what you need

---

## Troubleshooting

### "Unknown option `--remote`" error

The `--remote` flag doesn't work with `pnpm dev` because Vite doesn't support it. Additionally, Durable Objects don't support `remote: true` configuration like R2 buckets and Vectorize indexes do. Use the backfill method described above instead.

### Local DOs are empty

If your local Durable Objects appear empty:

1. Run the backfill script to populate local data: `./scripts/local-backfill.sh github/`
2. Check worker logs to see if indexing is in progress
3. Verify that your local worker can access the remote R2 bucket (check that R2 binding has `remote: true` in `wrangler.jsonc`)

### Can't connect to remote R2

Ensure your R2 bucket binding has `remote: true` in `wrangler.jsonc`. This is required for both options since source documents are stored in R2.
