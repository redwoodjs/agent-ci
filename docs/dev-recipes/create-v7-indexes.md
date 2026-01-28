# Create Vectorize v7 Indexes

This recipe documents the steps to create a new set of Vectorize indexes (v7) when previous versions (e.g., v6) become stalled or unresponsive.

## Context
When Vectorize indexes stop returning results despite successful upsert logs, it may be necessary to recreate them.

## Steps

### 1. Authenticate Wrangler
If using environment variables (`CLOUDFLARE_API_TOKEN`) results in authentication errors (code 10000), use browser-based OAuth:

```bash
# Unset existing Cloudflare env vars if they interfere
unset CLOUDFLARE_API_TOKEN
unset CLOUDFLARE_ACCOUNT_ID
unset CI

# When running commands below to create indexes, it'll prompt you to login via browser
```

### 2. Create the Indexes
Create the three main indexes with 768 dimensions and cosine metric:

```bash
npx wrangler vectorize create moment-index-v7 --dimensions=768 --metric=cosine
npx wrangler vectorize create subject-index-v7 --dimensions=768 --metric=cosine
npx wrangler vectorize create rag-index-v7 --dimensions=768 --metric=cosine
```

### 3. Update Configuration
Update `wrangler.jsonc` to point to the new index names:

```jsonc
"vectorize": [
  {
    "binding": "VECTORIZE_INDEX",
    "index_name": "rag-index-v7",
    "remote": true
  },
  {
    "binding": "SUBJECT_INDEX",
    "index_name": "subject-index-v7",
    "remote": true
  },
  {
    "binding": "MOMENT_INDEX",
    "index_name": "moment-index-v7",
    "remote": true
  }
]
```

## Maintenance Notes
- **Rollback**: To rollback, simply revert the `index_name` values in `wrangler.jsonc`.
