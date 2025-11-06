# 2025-11-06: GitHub Ingestion

## Problem

I need to create an ingestion pipeline for GitHub data, including issues, pull requests, comments, releases, and projects. Unlike the streaming nature of the Cursor ingestor, this data is object-based and requires a system to handle creations, updates, and deletions while preserving a historical record of changes. The ingested data should be stored as Markdown files in an R2 bucket.

## Brainstorming & Architecture

The core of this problem is managing the state of GitHub objects over time. A simple "fetch and store" approach won't work because it doesn't account for updates or deletions, and it can't preserve history.

### Ingestion Strategy: Hybrid Approach

A hybrid model using both Webhooks and API polling seems like the most robust solution:
-   **Webhooks**: For real-time updates. GitHub will notify our service immediately when an issue is created, a comment is posted, etc. This is efficient and provides low-latency data ingestion.
-   **API Polling**: As a scheduled task (cron job). This will be used for backfilling historical data and for ensuring data consistency. Webhooks can sometimes fail, and polling acts as a reconciliation mechanism to catch any missed events.

### State Management: Durable Object per Repository

To manage the state of each repository's data, I'll follow the pattern from the Cursor ingestor and use Durable Objects.
-   **One DO per Repository**: Each GitHub repository will be mapped to a unique `GitHubRepoDurableObject` instance. This encapsulates the state and logic for a single repository, making the system scalable and avoiding contention on a single database.
-   **SQLite Backend**: Each DO will contain its own SQLite database to track the metadata of all ingested objects (issues, PRs, etc.). This database will be the source of truth for what has been stored and what the latest version of any given object is.

### Data Storage & Versioning

This is the most critical part of the design. We need to store Markdown files in R2 while keeping a full history.

-   **R2 Storage Structure**: Content will be stored in R2 with a versioned path, like:
    `github-ingest/{owner}/{repo}/issues/{issue_number}/{version_hash}.md`
    The `version_hash` could be a timestamp or a commit SHA from the GitHub event payload.

-   **Database Schema for Versioning**: The DO's SQLite database will manage the versions. For each object type (e.g., issues), we'll have two tables:
    1.  A main table (`issues`) that stores metadata and a pointer to the *current* version.
        -   `github_id` (PK)
        -   `number`
        -   `title`
        -   `state` (`open`, `closed`, `deleted`)
        -   `latest_version_id` (FK to `issue_versions`)
    2.  A versions table (`issue_versions`) that logs every historical version.
        -   `id` (PK)
        -   `issue_github_id` (FK to `issues`)
        -   `r2_key` (The path to the Markdown file in R2)
        -   `created_at`

This design allows us to quickly retrieve the latest version of any object while also being able to traverse its entire history by querying the versions table.

### Handling Operations

-   **Create**: A new object (e.g., `issues.opened` webhook) results in a new record in the `issues` table and the `issue_versions` table, and a new file in R2.
-   **Update**: An edit (e.g., `issues.edited`) results in a *new* record in `issue_versions` and a *new* file in R2. The `latest_version_id` in the main `issues` table is then updated to point to this new version. The old version remains untouched.
-   **Delete**: A deletion (e.g., `issues.deleted`) will not remove any data. Instead, the `state` in the `issues` table will be updated to `deleted`. This preserves the history of the object while flagging it as no longer active.

## Plan of Action

I'll implement this in phases, starting with the core infrastructure for a single data type (Issues) and expanding from there.

1.  **Phase 1: Core Infrastructure**
    -   Set up the directory structure at `src/app/ingestors/github/`.
    -   Create the `GitHubRepoDurableObject` and define the SQLite schema and migrations for `issues` and `issue_versions`.
    -   Implement the webhook endpoint (`/ingestors/github/webhook`) with GitHub webhook signature validation.

2.  **Phase 2: Webhook Ingestion for Issues**
    -   Implement the logic inside the DO to handle issue-related webhook events (`opened`, `edited`, `closed`, `deleted`).
    -   Create a utility to convert the GitHub issue JSON payload into a clean Markdown format.
    -   Implement the logic to write the Markdown file to R2 and update the DO's database accordingly.

3.  **Phase 3: Backfill Mechanism**
    -   Create a new endpoint for handling backfill requests, to be triggered by a cron job.
    -   Implement the logic to fetch issues from the GitHub API, compare them with the records in the DO, and ingest any missing or updated issues.

4.  **Phase 4: Expansion**
    -   Extend the system to handle other object types: Comments, PRs, Releases, and Projects, following the same versioning pattern.
    -   Create comprehensive documentation in `README.md` for setting up and using the ingestor.

## 2025-11-06: Phase 1 Implementation - Core Infrastructure

Implemented the foundational infrastructure for the GitHub ingestor:

**Database Layer:**
- Created `GitHubRepoDurableObject` extending `SqliteDurableObject` with migrations property pattern (matching cursor ingestor)
- Implemented migrations using `db.schema` API with named migrations (`001_initial_schema`) following the established pattern
- Created `issues` and `issue_versions` tables to track issue state and version history

**Webhook Security:**
- Implemented `requireGitHubWebhookSignature` interruptor using GitHub's X-Hub-Signature-256 header
- Used native Web Crypto API (no Node.js Buffer) for HMAC signature verification
- Implemented constant-time string comparison to prevent timing attacks

**Route Setup:**
- Created webhook endpoint at `/ingestors/github/webhook` using the `route()` pattern from rwsdk/router
- Registered routes and Durable Object in worker.tsx and wrangler.jsonc
- Added v4 migration for GitHubRepoDurableObject

**Issues Fixed:**
- Corrected Durable Object pattern: use `migrations = migrations` property instead of constructor
- Fixed migrations structure: use `db.schema` API with named migrations and `satisfies Migrations`
- Replaced Node.js Buffer with native Web APIs for hex encoding/decoding
- Fixed route structure to match cursor ingestor pattern (export routes array, not Router instance)
- Added proper TypeScript types using `RequestInfo` from rwsdk/worker
