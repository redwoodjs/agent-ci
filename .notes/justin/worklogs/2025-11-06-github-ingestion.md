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

2.  **Phase 2: Webhook Ingestion for Issues** ✓ COMPLETE
    -   Implemented the logic inside the DO to handle issue-related webhook events (`opened`, `edited`, `closed`, `reopened`, `deleted`).
    -   Created a utility to convert the GitHub issue JSON payload into a clean Markdown format with YAML front matter.
    -   Implemented the logic to write the Markdown file to R2 and update the DO's database accordingly.

3.  **Phase 3: Expansion (PRs, Comments, Releases)** ✓ COMPLETE
    -   Extended the system to handle PRs, Comments, and Releases.
    -   Added webhook handlers and Markdown converters for each type.
    -   Added database tables and migrations for version tracking.

4.  **Phase 4: Expansion (Projects)**
    -   Extend the system to handle Projects and Project Items.
    -   Add webhook handlers for `project_v2` and `projects_v2_item` events.
    -   Add database tables and migrations for `projects` and `project_items`.

5.  **Phase 5: Backfill Mechanism**
    -   Create a unified backfill endpoint that can handle all object types (Issues, PRs, Comments, Releases, Projects).
    -   Implement logic to fetch data from the GitHub API for each type.
    -   Compare with existing records in the DO and ingest any missing or updated objects.
    -   Can be triggered by a cron job or manually.

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

**Issue Fixed - Foreign Key Constraint:**

During testing, encountered "FOREIGN KEY constraint failed" error when creating new issues. The problem was in the insertion order: we were inserting into `issue_versions` before inserting into `issues`. Since `issue_versions.issue_github_id` has a foreign key reference to `issues.github_id`, SQLite rejected the insert because the parent record didn't exist yet.

Fix: Reverse the insertion order for new issues - insert into `issues` first, then insert into `issue_versions`. This ensures the parent record exists before the child record references it.

**Issues Fixed:**
- Corrected Durable Object pattern: use `migrations = migrations` property instead of constructor
- Fixed migrations structure: use `db.schema` API with named migrations and `satisfies Migrations`
- Replaced Node.js Buffer with native Web APIs for hex encoding/decoding
- Fixed route structure to match cursor ingestor pattern (export routes array, not Router instance)
- Added proper TypeScript types using `RequestInfo` from rwsdk/worker

## 2025-11-06: Entity Lifecycle Analysis - Planning Phase 3 Expansion

Before implementing support for PRs, Comments, Releases, and Projects, analyzing the lifecycle of each entity to ensure we have the right provisions for versioning and relationships.

### Principles

- Keep it simple (Occam's razor) - best bang for buck, not heavy-handed
- Focus on preserving information and links, not perfect structure
- Capture what GitHub sends us via webhooks
- Maintain version history for all edits
- Preserve links between entities (comments → issues/PRs, etc.)
- Structure is good as long as information is there and easy to process
- Can refine structure later based on actual usage needs

### Entity Lifecycle Analysis

**Issues:**
- Events: `opened`, `edited`, `closed`, `reopened`, `deleted`
- What changes: title, body, labels, assignees, milestone
- Comments: Separate entity (`issue_comment` events) - not part of issue itself
- Versioning: Each `edited` event creates new version. State changes (`closed`/`reopened`) also create versions to track state transitions.
- Links: Comments link to issues via `issue_id`

**Pull Requests:**
- Events: `opened`, `edited`, `closed`, `reopened`, `merged`, `synchronize` (new commits pushed)
- What changes: title, body, labels, assignees, milestone, base/head branches
- Commits: Pushing commits triggers `synchronize` event - this is a state change, not content edit
- Comments: Separate entities - PR comments (`pull_request_review_comment`) and review comments (`issue_comment` on PR)
- Reviews: Separate entities (`pull_request_review` events)
- Versioning: `edited` creates new version. `synchronize` creates version to track commit updates. `merged`/`closed` create versions for state.
- Links: Comments, reviews link to PR via `pull_request_id`

**Comments (Issue Comments & PR Comments):**
- Events: `created`, `edited`, `deleted`
- What changes: body/content
- Parent relationship: Links to issue or PR
- Versioning: Each `edited` creates new version. `deleted` marks as deleted but preserves history.
- Links: Must track `issue_id` or `pull_request_id` to maintain relationship

**Releases:**
- Events: `published`, `edited`, `deleted`, `prereleased`, `released`
- What changes: name, body, tag, assets
- Less frequently changed than issues/PRs
- Versioning: `edited` creates new version. State transitions (`prereleased` → `released`) create versions.
- Links: Links to repository, may reference issues/PRs in body

**Projects:**
- Events: `created`, `updated`, `closed`, `deleted`
- Project items: Separate entities (`project_card`, `project_column` events)
- More complex structure with columns, cards, items
- Versioning: `updated` creates new version. State changes tracked.
- Links: Cards link to issues/PRs, columns contain cards

### Key Decisions

1. **Separate entities for comments**: Comments are not part of issues/PRs - they're separate objects with their own lifecycle. This matches GitHub's webhook structure.

2. **State changes create versions**: Not just content edits. `closed`, `reopened`, `merged`, `synchronize` all create versions to track the evolution of the entity.

3. **Links via foreign keys**: Comments store `issue_id` or `pull_request_id`. PRs might reference issues. Keep these relationships in the database schema.

4. **Simplified structure**: Don't try to model every nuance. If GitHub sends an event, we process it. If it's an edit, we version it. Keep the structure flat and simple - can refine later.

5. **Same pattern for all**: Each entity type follows the same pattern:
   - Main table (e.g., `pull_requests`) with metadata and `latest_version_id`
   - Versions table (e.g., `pull_request_versions`) tracking all versions
   - Markdown files in R2 with versioned paths
   - Links to parent entities where applicable

6. **Don't overthink commits**: `synchronize` events on PRs are just state changes - we version them but don't need to deeply model commit relationships at this stage.

### Implementation Plan for Phase 3

1. **Database Schema Expansion:**
   - Add tables: `pull_requests`, `pull_request_versions`
   - Add tables: `comments`, `comment_versions` (unified for issue and PR comments)
   - Add tables: `releases`, `release_versions`
   - Add tables: `projects`, `project_versions` (if needed, or defer if too complex)
   - All follow same pattern: main table + versions table

2. **Webhook Handlers:**
   - `pull_request` events: opened, edited, closed, reopened, merged, synchronize
   - `issue_comment` events: created, edited, deleted
   - `pull_request_review_comment` events: created, edited, deleted
   - `release` events: published, edited, deleted, prereleased, released
   - `project` events: created, updated, closed, deleted (maybe defer if complex)

3. **Markdown Converters:**
   - `prToMarkdown` - similar to issue converter
   - `commentToMarkdown` - simpler, just body + metadata
   - `releaseToMarkdown` - includes tag, assets info
   - `projectToMarkdown` - if implementing projects

4. **Processor Services:**
   - `processPullRequestEvent` - handles PR lifecycle
   - `processCommentEvent` - handles comment lifecycle (unified for issue/PR comments)
   - `processReleaseEvent` - handles release lifecycle
   - `processProjectEvent` - if implementing projects

5. **R2 Storage Paths:**
   - PRs: `github-ingest/{owner}/{repo}/pull-requests/{number}/{version_hash}.md`
   - Comments: `github-ingest/{owner}/{repo}/issues/{issue_number}/comments/{comment_id}/{version_hash}.md` or `pull-requests/{pr_number}/comments/{comment_id}/{version_hash}.md`
   - Releases: `github-ingest/{owner}/{repo}/releases/{tag}/{version_hash}.md`
   - Projects: `github-ingest/{owner}/{repo}/projects/{project_id}/{version_hash}.md` (if implementing)

6. **Simplifications:**
   - Use same Durable Object per repository (already have `GitHubRepoDurableObject`)
   - Comments table unified - use `issue_id` or `pull_request_id` to distinguish
   - Don't deeply model commit relationships - just version PRs when commits are pushed
   - Don't deeply model project structure (columns/cards) - just version the project itself
   - Keep it simple - capture what GitHub sends, preserve versions, maintain links

### Decisions Made

1. **Projects**: Deferred to a later phase due to complexity.
2. **PR Reviews**: Will be treated as part of the PR's version history. Submitting a review will create a new version of the PR.
3. **PR Review Comments**: The `comments` table will include a `review_id` to link comments to their specific review.
4. **`synchronize` events**: Will be handled by creating a new version of the PR, without tracking individual commit diffs.

### Recommendation

Start with Issues (done), PRs, Comments, and Releases. Defer Projects if they add too much complexity. Keep the structure simple - same pattern for all entities. Focus on capturing information and maintaining links, not perfect modeling.

## 2025-11-06: Phase 3 Implementation - Expansion for PRs, Comments, Releases

Implemented the extension of the ingestor to handle Pull Requests, Comments, and Releases, following the same architectural pattern established for Issues.

**Database Schema:**
- Added new tables with a new migration (`002_add_prs_comments_releases`):
  - `pull_requests` and `pull_request_versions`
  - `comments` and `comment_versions` (unified for issue and PR comments, with `review_id` for PR review comments)
  - `releases` and `release_versions`

**Markdown Converters:**
- Created `prToMarkdown.ts`, `commentToMarkdown.ts`, and `releaseToMarkdown.ts` utilities to convert JSON payloads to Markdown with YAML front matter.

**Processor Services:**
- Implemented `pr-processor.ts`, `comment-processor.ts`, and `release-processor.ts` to handle the lifecycle events for each entity, including creating and versioning records in the database and storing artifacts in R2.

**Webhook Handler:**
- Updated `routes.ts` to recognize and route events for `pull_request`, `issue_comment`, `pull_request_review_comment`, and `release` to their respective processors.

**Type Safety:**
- Corrected payload type definitions in `routes.ts` to account for scenarios where GitHub provides a partial object (e.g., just the `id` of an issue in a comment payload), ensuring robust parsing.

## 2025-11-06: Phase 4 Planning - GitHub Projects

### Acknowledging the Complexity

The initial decision to defer Projects was based on their unique structure compared to other GitHub entities. The core complexity is that interactions with project items (like moving an issue between columns) do not trigger webhooks on the issue itself. Instead, GitHub uses a separate set of webhooks (`project_v2` and `projects_v2_item`) and a distinct "Project Item" entity that acts as a link between a Project and an Issue/PR.

### A Simplified Approach

We can ingest project data by embracing this structure and applying our existing patterns, without needing to model the entire complexity of project boards (e.g., custom fields, views).

1.  **Track Two New Entities**: We will introduce two new entities to our system:
    *   **Projects**: The project itself (title, description). This will have `projects` and `project_versions` tables.
    *   **Project Items**: The link between a project and an issue/PR. This will have `project_items` and `project_item_versions` tables. The `project_items` table will store foreign keys (`project_github_id`, `issue_github_id`) and any relevant metadata, such as the item's status (i.e., its column).

2.  **Handle Project Webhooks**:
    *   `project_v2.edited`: A change to the project's title or description creates a new version in `project_versions`.
    *   `projects_v2_item.created`: An issue/PR being added to a project creates a new record in `project_items`.
    *   `projects_v2_item.edited`: An issue/PR being moved between columns creates a new version in `project_item_versions` with the updated status. The original issue is not touched.
    *   `projects_v2_item.deleted`: An issue/PR being removed from a project updates the state of the record in `project_items`.

This approach successfully captures the essential relationships and historical changes without being overly complex, aligning with our "best bang for buck" principle.

## Architectural Reconsideration: Entity-based vs. Event-based Ingestion

Before proceeding with the Projects implementation, it's worth pausing to validate our core architectural approach. The question arose: would a simpler, event-streaming model be more effective than the current entity-based versioning model?

### The Two Models

1.  **Event-based Model (The Alternative)**: In this model, we would not attempt to understand the incoming data. We would simply store every raw webhook payload as a timestamped event. The storage would be a flat log of everything that has happened.
2.  **Entity-based Model (The Current Approach)**: In this model, we parse incoming webhooks to understand the entities they represent (Issues, PRs, Comments). We maintain a record of the current state of each entity and store historical changes as distinct, queryable versions.

### Analysis of Trade-offs

The primary goal is to build an AI-searchable knowledge base. The AI needs a structured, semantic understanding of the data to be effective.

-   **The Backfill Problem**: This is the most significant challenge for the event-based model. The GitHub API provides the *current state* of an entity, not a historical log of the events that modified it. To backfill a repository, we would get the current state of all issues, but we would have no way to get the historical event stream. We could try to create artificial "issue created" events for the backfill, but this would make the data model inconsistent and complex.

-   **Data Structure for the AI**: An AI would struggle to derive a coherent "state of the world" from a flat log of events. It would have to reconstruct the current state of an issue by replaying all historical events every time it needed to understand it. The entity-based model, by contrast, provides this immediately. It presents the data in its semantic form, which is what the AI needs to understand relationships (e.g., this comment belongs to this issue).

-   **Historical Queries**: While an event log is a history in itself, finding the state of an entity at a specific point in time would require replaying events. Our versioned-entity model makes this more direct. If the AI needs to understand how an issue evolved, it can traverse its explicit `issue_versions`.

### Conclusion

After thinking through the options, the current **entity-based model is the correct approach**.

While it requires more upfront work to model the schemas, it solves the critical backfill problem and, most importantly, provides the structured, semantic data model that is essential for the end goal of an AI-powered knowledge base. The event-streaming model, while simpler on the surface, fails to meet these core requirements. This thought process validates that we are on the right track.

## 2025-11-06: Phase 5 Planning - Backfill Mechanism

### Problem

We need a mechanism to ingest historical data from GitHub repositories and to reconcile any events that might have been missed by the real-time webhook ingestor (e.g., due to downtime or webhook delivery failures). This process needs to be triggerable, manageable, and testable.

### Proposed Architecture: Endpoint + Queue

A robust solution involves a combination of a trigger endpoint and a queue for processing. This avoids hitting execution limits on a single request and builds in resiliency.

1.  **Trigger Endpoint**: A new endpoint, `POST /ingestors/github/backfill`, will initiate the backfill process. It will be protected by the `INGEST_API_KEY`.
2.  **GitHub API Token**: The backfill process will require read-only access to the GitHub API, configured via a `GITHUB_TOKEN` secret in the worker.
3.  **Cloudflare Queues for Processing**: The trigger endpoint will not process the data itself. Instead, it will query the GitHub API for a list of items to backfill (e.g., all issue numbers in a repo) and push a job for each item onto a Cloudflare Queue.
4.  **Queue Consumer**: A queue consumer will be responsible for processing each job. The consumer will fetch the full details of a single item (e.g., a specific issue) from the GitHub API and pass it to the appropriate, existing `process...Event` service.
5.  **Reusing Existing Logic**: By channeling backfilled data through the same `process...Event` services (`processIssueEvent`, `processPullRequestEvent`, etc.), we ensure that data is handled consistently, whether it comes from a webhook or the backfill. The processor will treat the item as an "edited" event, creating a new version if the content has changed.

### Endpoint Design

-   **Route**: `POST /ingestors/github/backfill`
-   **Authentication**: `Authorization: Bearer <INGEST_API_KEY>`
-   **Request Body**:
    ```json
    {
      "owner": "string",
      "repo": "string",
      "entity": "issues" | "pull_requests" | "releases" | "comments" | "all",
      "since": "YYYY-MM-DDTHH:MM:SSZ", // Optional: only fetch items updated since this date
      "limit": "number" // Optional: limit the number of items to backfill (for testing)
    }
    ```

### Testing Plan for a Minimal Backfill

This design allows for easy, controlled testing on a test deployment.

1.  **Configure Secret**: Add a `GITHUB_TOKEN` to the test worker environment. This token needs `repo` scope to read repository data.
    ```bash
    npx wrangler secret put GITHUB_TOKEN
    ```
2.  **Deploy**: Deploy the worker with the new backfill endpoint and queue consumer.
3.  **Trigger Test**: Use a `curl` command to trigger a small, specific backfill. For example, to backfill the 5 most recently updated issues from a test repository:
    ```bash
    curl -X POST "https://<your-test-worker-url>/ingestors/github/backfill" \
      -H "Authorization: Bearer <your-ingest-api-key>" \
      -H "Content-Type: application/json" \
      -d '{
            "owner": "your-github-username",
            "repo": "your-repo-name",
            "entity": "issues",
            "limit": 5
          }'
    ```
4.  **Verify**: Check the R2 bucket for the newly created Markdown files. Check the worker logs for output from the queue consumer to confirm processing.
