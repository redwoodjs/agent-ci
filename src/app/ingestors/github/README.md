# GitHub Ingestor

This service ingests data from GitHub repositories, including issues, pull requests, comments, releases, and projects. It stores this data as Markdown files in R2, maintaining a complete version history of all changes.

## Setup

### 1. Configure GitHub Webhook Secret

**Get your webhook secret from GitHub:**
- Go to your repository settings → Webhooks
- Create or edit a webhook
- In the "Secret" field, GitHub generates or lets you set a secret
- Copy this secret value

**Set the environment variable:**

For local development (in `.dev.vars` or similar):
```bash
GITHUB_WEBHOOK_SECRET=your_secret_here
```

For production, set as a Cloudflare Worker secret:
```bash
wrangler secret put GITHUB_WEBHOOK_SECRET
# Then paste your secret when prompted
```

### 2. Configure GitHub Webhook

- Set the webhook URL to: `https://your-domain.workers.dev/ingestors/github/webhook`
- Set the content type to: `application/json`
- Select the events you want to receive (issues, pull_requests, etc.)
- Make sure the "Secret" field matches what you set in the environment variable

The endpoint will verify all incoming webhook requests using HMAC-SHA256 signature verification. Requests with missing or invalid signatures will be rejected with `401 Unauthorized`.
