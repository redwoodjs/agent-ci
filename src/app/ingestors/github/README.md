# GitHub Ingestor

This service ingests data from GitHub repositories, including issues, pull requests, comments, releases, and projects. It stores this data as Markdown files in R2, maintaining a complete version history of all changes.

## Setup

### 1. Configure Webhook Secret

The GitHub ingestor uses the same `INGEST_API_KEY` secret that other ingestors use. If you already have this configured for the Cursor ingestor, you can reuse the same value.

**Set the environment variable:**

For local development (in `.dev.vars` or similar):
```bash
INGEST_API_KEY=your_secret_here
```

For production, set as a Cloudflare Worker secret:
```bash
wrangler secret put INGEST_API_KEY
# Then paste your secret when prompted
```

### 2. Configure GitHub Webhook

- Go to your organization settings → Webhooks
- Create or edit a webhook
- Set the webhook URL to: `https://your-domain.workers.dev/ingestors/github/webhook`
- Set the content type to: `application/json`
- Select the events you want to receive (issues, pull_requests, etc.)
- In the "Secret" field, enter the **same value** as your `INGEST_API_KEY`

The endpoint will verify all incoming webhook requests using HMAC-SHA256 signature verification. Requests with missing or invalid signatures will be rejected with `401 Unauthorized`.

## Backfilling Historical Data

The GitHub ingestor includes a backfill mechanism to ingest historical data from repositories. This is useful for initial setup or catching up on data that existed before webhooks were configured.

### Setup

1. **Configure GitHub Token**: Set a GitHub personal access token with appropriate permissions:

   ```bash
   wrangler secret put GITHUB_TOKEN
   # Then paste your token when prompted
   ```

   The token needs the following permissions:
   - `repo` (for accessing repository data: issues, pull requests, comments, releases)
   - `read:org` (for accessing organization-level data)
   - `read:project` (for accessing Projects v2 data via GraphQL API)

2. **Create Queues**: The backfill system uses Cloudflare Queues. These must be created manually before deployment. Each environment (test/production) needs its own set of queues.

   **For production (default) environment:**
   ```bash
   npx wrangler queues create github-scheduler-queue-prod
   npx wrangler queues create github-processor-queue-prod
   npx wrangler queues create github-processor-queue-prod-dlq
   ```

   **For test environment:**
   ```bash
   npx wrangler queues create github-scheduler-queue
   npx wrangler queues create github-processor-queue
   npx wrangler queues create github-processor-queue-dlq
   ```

   You can verify they exist:
   ```bash
   wrangler queues list
   ```

   **Note**: When deploying to test, use the `--env test` flag:
   ```bash
   npx wrangler deploy --env test
   ```

### Usage

To start a backfill for a repository, make a POST request to the backfill endpoint. If you have `INGEST_API_KEY` in your `.dev.vars` file, you can source it and use it in the curl command:

```bash
source .dev.vars
curl -X POST https://your-domain.workers.dev/ingestors/github/backfill \
  -H "Authorization: Bearer $INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"owner": "octocat", "repo": "Hello-World"}'
```

**Response:**
```json
{
  "success": true,
  "repository_key": "octocat/Hello-World",
  "message": "Backfill job started",
  "test_run": false
}
```

**Test Run:**

To run a limited test that processes only the first page of issues (up to 100 items), include `"test_run": true`:

```bash
source .dev.vars
curl -X POST https://your-domain.workers.dev/ingestors/github/backfill \
  -H "Authorization: Bearer $INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"owner": "octocat", "repo": "Hello-World", "test_run": true}'
```

This is useful for validating the pipeline end-to-end without waiting for a full repository backfill to complete. The test run will process only the first page of the first entity type (issues) and then stop, marking the backfill as `completed`.

### How It Works

The backfill process uses a two-tiered queue system:

1. **Scheduler Queue**: Fetches pages of data from the GitHub API and enqueues individual entity processing jobs.
2. **Processor Queue**: Processes individual entities (issues, PRs, comments, etc.) using the same idempotent processors used by webhooks.

The backfill processes entities in this order:
1. Issues
2. Pull Requests
3. Comments
4. Releases
5. Projects (organization-level)

### Monitoring

Backfill state is stored in a Durable Object (`GitHubBackfillStateDO`). You can check the status by querying the state:

- `pending`: Backfill has been initiated but not started
- `in_progress`: Backfill is actively running
- `completed`: Backfill has finished successfully
- `paused_on_error`: Backfill encountered an error and has been paused

If a backfill is paused due to an error, you can resume it by making another backfill request for the same repository. The system will continue from where it left off.

### Error Handling

If a processor job fails repeatedly (after 3 retries), it is sent to a dead-letter queue (`github-processor-queue-dlq`). The dead-letter handler will:
1. Update the backfill state to `paused_on_error`
2. Record the error message and details
3. Stop the scheduler from enqueuing more work for that repository

To resume after fixing the issue, make another backfill request for the same repository.

### Pausing a Backfill

To manually pause a running backfill:

```bash
source .dev.vars
curl -X POST https://your-domain.workers.dev/ingestors/github/backfill/pause \
  -H "Authorization: Bearer $INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"owner": "redwoodjs", "repo": "machinen"}'
```

**Response:**
```json
{
  "success": true,
  "repository_key": "redwoodjs/machinen",
  "message": "Backfill paused"
}
```

The scheduler will skip processing jobs for paused backfills. To resume, make another backfill request for the same repository (this will reset the state and start fresh).
