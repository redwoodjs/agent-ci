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
