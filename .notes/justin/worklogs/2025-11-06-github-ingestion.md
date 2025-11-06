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

-   **Markdown Format**: Each stored Markdown file will include YAML front matter for metadata:
    ```markdown
    ---
    github_id: 123456
    number: 42
    state: open
    created_at: 2025-11-06T10:00:00Z
    updated_at: 2025-11-06T11:00:00Z
    version_hash: abc123...
    ---
    
    # Issue Title
    
    Issue body content...
    ```
    This approach keeps metadata accessible without parsing the full document structure, while the body remains readable Markdown. Front matter allows us to store structured data (issue number, state, timestamps, etc.) alongside the content, making it easier to query and understand file contents without needing to parse the Markdown itself.

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

**Webhook Signature Verification Details:**

GitHub webhooks include a cryptographic signature in the `X-Hub-Signature-256` header that allows verification that requests actually came from GitHub. This prevents unauthorized webhook deliveries.

How it works:
1. GitHub generates an HMAC-SHA256 signature using the webhook secret (configured in GitHub's webhook settings) and the raw request body
2. GitHub sends this signature in the `X-Hub-Signature-256` header with format: `sha256=<hex_string>`
3. Our endpoint reads the raw request body (using `request.clone().text()` so the handler can still parse it as JSON) and independently computes the expected signature using the same secret stored in `GITHUB_WEBHOOK_SECRET`
4. If signatures match (using constant-time comparison), request is authenticated; otherwise returns 401 Unauthorized

Why constant-time comparison matters:
The `constantTimeEqual` function ensures the comparison always takes the same amount of time regardless of where strings differ. This prevents timing attacks where an attacker could potentially infer the correct signature by measuring how long the comparison takes. Regular string comparison (`===`) can leak information through timing because it may return early when it finds the first differing character. Our implementation uses XOR operations (`^`) to compare all characters, then checks if the result is zero, ensuring uniform execution time.

Implementation choices:
- Used native Web Crypto API (`crypto.subtle`) instead of Node.js Buffer for Cloudflare Workers compatibility
- Created helper functions `arrayBufferToHex` and `constantTimeEqual` for signature processing
- Signature verification happens before any request body parsing to ensure security

**Comparison with Cursor Ingestor Authentication:**

The Cursor ingestor currently uses Bearer token authentication (API key in Authorization header), while GitHub uses HMAC-SHA256 signature verification. The GitHub approach is more secure because:
- The secret never travels over the network (only the signature does)
- Provides payload integrity verification (can detect tampering)
- Even if intercepted, requests can't be forged without the secret

However, upgrading Cursor to HMAC signatures is lower priority because:
- Cursor hooks run locally on trusted user machines (different threat model than external webhooks)
- If someone has access to a user's environment variables, they already have significant access
- Network interception risks are lower since requests originate from the user's own machine

The main risks of keeping Bearer token auth for Cursor:
- Low-Medium: API key could be exposed if HTTPS fails, headers are logged, or through proxy/MITM attacks
- Low: No payload integrity verification (can't detect tampering)
- Very low: Local execution mitigates most external threats

This is worth upgrading eventually for defense-in-depth and consistency, but not urgent.

**Markdown Format Decision:**

Decided to use YAML front matter in stored Markdown files for metadata. This approach:
- Keeps metadata accessible without parsing the full Markdown document
- Allows structured data (github_id, number, state, timestamps, version_hash) alongside readable content
- Makes it easier to query and understand file contents without full Markdown parsing
- Maintains readability - the body remains standard Markdown that can be rendered directly

Example format:
```markdown
---
github_id: 123456
number: 42
state: open
created_at: 2025-11-06T10:00:00Z
updated_at: 2025-11-06T11:00:00Z
version_hash: abc123...
---

# Issue Title

Issue body content...
```

**Route Setup:**
- Created webhook endpoint at `/ingestors/github/webhook` using the `route()` pattern from rwsdk/router
- Registered routes and Durable Object in worker.tsx and wrangler.jsonc
- Added v4 migration for GitHubRepoDurableObject

**Authentication Simplification:**
Initially planned to use a separate `GITHUB_WEBHOOK_SECRET` for GitHub webhook signature verification. Changed to reuse `INGEST_API_KEY` instead, so users only need to manage one secret value. The same secret works for:
- Cursor ingestor: Bearer token authentication (`Authorization: Bearer <key>`)
- GitHub ingestor: HMAC-SHA256 webhook signature verification (secret value used to verify `X-Hub-Signature-256` header)
This simplifies setup - if users already have `INGEST_API_KEY` configured, they can use the same value in GitHub's webhook secret field.

**Phase 1 Testing:**
Phase 1 implementation complete and validated:
- Webhook endpoint responds correctly
- Signature verification working (rejects invalid signatures, accepts valid ones)
- Endpoint receives and parses GitHub webhook payloads
- Durable Object migration applies successfully

## 2025-11-06: Phase 2 Implementation - Webhook Ingestion for Issues

Implemented complete webhook processing for GitHub issues:

**Webhook Handler:**
- Updated `/ingestors/github/webhook` to handle `issues` events
- Routes to `processIssueEvent` for supported actions: `opened`, `edited`, `closed`, `reopened`, `deleted`
- Validates payload structure and returns appropriate error responses

**Issue Processor Service:**
- `processIssueEvent` handles all issue lifecycle events
- Uses repository owner/name as Durable Object key (one DO per repository)
- Creates new issue records or updates existing ones
- Creates version records for each change (except deletions)
- Stores Markdown files in R2 with versioned paths: `github-ingest/{owner}/{repo}/issues/{number}/{version_hash}.md`

**Markdown Conversion:**
- `issueToMarkdown` utility converts GitHub issue JSON to Markdown with YAML front matter
- Front matter includes: github_id, number, state, created_at, updated_at, version_hash
- Body includes issue title, author, labels, assignees, milestone, and content
- Uses proper YAML escaping for values containing special characters

**Version Management:**
- Each update creates a new version record with unique R2 key
- Version hash generated from issue content (SHA-256 of id, updated_at, body, title)
- Database tracks latest_version_id in issues table for quick access
- Deleted issues update state but preserve history (no new version created)

**State Handling:**
- `closed` action sets state to "closed"
- `reopened` action sets state to "open" regardless of issue.state value
- Other actions respect issue.state from payload
- Deleted issues marked as "deleted" state, preserving all previous versions

**Issues Fixed:**
- Corrected Durable Object pattern: use `migrations = migrations` property instead of constructor
- Fixed migrations structure: use `db.schema` API with named migrations and `satisfies Migrations`
- Replaced Node.js Buffer with native Web APIs for hex encoding/decoding
- Fixed route structure to match cursor ingestor pattern (export routes array, not Router instance)
- Added proper TypeScript types using `RequestInfo` from rwsdk/worker
