# Production Release Guide

This document explains how to deploy **Opposite-Actions** into production, from creating the GitHub App to running the local agent.

## 1. Overview & Prerequisites

**Opposite-Actions** uses a three-tier architecture:

1.  **GitHub App**: Triggers jobs via webhooks.
2.  **Cloudflare Bridge**: Orchestrates jobs and tracks runner presence.
3.  **Local Runner**: Polls the Bridge and executes jobs in Docker.

### Prerequisites

- **Node.js** (v20+) and **pnpm** (v10+).
- **Cloudflare Account** with Workers and KV enabled.
- **Docker**: For MacOS users, **[Orbstack](https://orbstack.dev/)** is highly recommended for its performance and low resource usage compared to Docker Desktop.
- **1Password CLI (`op`)**: Recommended for managing secrets securely.

---

## 2. GitHub App Setup

The GitHub App is responsible for sending `workflow_job` events to the Bridge.

1.  Go to **GitHub Settings > Developer Settings > GitHub Apps > New GitHub App**.
2.  **Name**: `Opposite-Actions-Runner` (or similar).
3.  **Homepage URL**: Your project URL.
4.  **Webhook**:
    - **URL**: `https://[YOUR_BRIDGE_ADDRESS]/api/webhook`
    - **Webhook Secret**: Generate a long, random string.
5.  **Repository Permissions**:
    - `Actions`: Read-only
    - `Contents`: Read-only
    - `Metadata`: Read-only
6.  **Subscribe to events**:
    - `Workflow job`
7.  **Private Key**: After creating the app, scroll down and click **Generate a private key**. Save the `.pem` file safely.
8.  **App ID**: Note the `App ID` displayed on the General settings page.
9.  **Install App**: On the left sidebar, click **Install App**, find your name or organization, and click **Install**.
    - _Note_: If you don't see your Organization here, it's likely because the app is "Private" to your personal account.
10. **Organization Installation (Optional)**: If you need to install the app on an organization:
    - Go to **General** on the left sidebar.
    - Scroll down to **Where can this GitHub App be installed?**.
    - Select **Any account** and click **Save changes**.
    - Now go back to **Install App** and your organization should appear.

---

## 3. Cloudflare (Bridge) Deployment

The Bridge runs on Cloudflare Workers and uses KV for job storage.

### 1. Set Secrets using 1Password

Before deploying, create an item in your **1Password** vault (e.g., in the `RedwoodJS` vault) named `OppositeActions` with the following fields:

- `GITHUB_WEBHOOK_SECRET`: The GitHub Webhook secret.
- `GITHUB_APP_ID`: The GitHub App ID.
- `GITHUB_PRIVATE_KEY`: The content of the private key `.pem` file.

You can then pipe these secrets directly into Wrangler using the 1Password CLI (`op`):

```bash
# Push Webhook Secret
op read "op://RedwoodJS/OppositeActions/GITHUB_WEBHOOK_SECRET" | npx wrangler secret put GITHUB_WEBHOOK_SECRET

# Push App ID
op read "op://RedwoodJS/OppositeActions/GITHUB_APP_ID" | npx wrangler secret put GITHUB_APP_ID

# Push Private Key
op read "op://RedwoodJS/OppositeActions/GITHUB_PRIVATE_KEY" | npx wrangler secret put GITHUB_PRIVATE_KEY
```

### 4. Deploy

```bash
pnpm --filter bridge release
```

---

## 4. Local Runner Setup

The Runner stays on your machine and communicates with the Bridge. It also manages the official GitHub Actions runner process for `opposite-actions` jobs.

### 1. Official GitHub Runner Setup

Before starting the OA-1 Runner, you must have an official GitHub Actions self-hosted runner configured on your machine.

1.  Follow the [official GitHub documentation](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners) to download and configure a runner for your repository or organization.
2.  **Do not** start it manually; the OA-1 Runner will handle this for you.
3.  Take note of the directory where you installed the runner.

### 2. Configure `.env`

Create a `.env` file in the root directory (the Runner will use this via symlink):

```bash
BRIDGE_URL=https://oa-1.[your-subdomain].workers.dev
BRIDGE_API_KEY=your-api-key
GITHUB_USERNAME=your-github-handle
```

**Note**: The OA-1 Runner will automatically search for the official runner's `./run.sh` in the current directory and the project root.

### 3. Start the Runner

```bash
# Install dependencies
pnpm install

# Run the runner process
pnpm --filter runner dev
```

---

## 5. Verification

1.  **Runner Presence**: Start the local runner. You should see `[Runner] Announcing availability to bridge...`.
2.  **Trigger a Job**: In a repository where the GitHub App is installed, trigger a workflow job (e.g., push a commit).
3.  **Bridge Logs**: Check Cloudflare Logs (`npx wrangler tail`) to see the webhook being received and the job being queued.
4.  **Runner Execution**: The local runner should log `[Runner] Found 1 jobs.` and start the Docker container.
5.  **GitHub UI**: The job in GitHub Actions should transition to "In Progress" as the local runner picks it up.
