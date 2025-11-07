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
5.  **Reusing Existing Logic**: By channeling backfilled data through the same `process...` functions (`processIssueEvent`, `processPullRequestEvent`, etc.), we ensure that data is handled consistently, whether it comes from a webhook or the backfill. The processor will treat the item as an "edited" event, creating a new version if the content has changed.

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

## 2025-11-06: Phase 4 Implementation - GitHub Projects

Implemented support for GitHub Projects and Project Items following the same pattern as other entities.

**Database Schema:**
- Added migration `003_add_projects` with tables:
  - `projects` and `project_versions` - tracks project metadata and version history
  - `project_items` and `project_item_versions` - tracks relationships between projects and issues/PRs, including status changes

**Markdown Converters:**
- Created `projectToMarkdown.ts` and `projectItemToMarkdown.ts` utilities to convert JSON payloads to Markdown with YAML front matter

**Processor Services:**
- Implemented `project-processor.ts` and `project-item-processor.ts` to handle lifecycle events for projects and project items

**Webhook Handlers:**
- Updated `routes.ts` to handle `projects_v2` and `projects_v2_item` events

**Debugging:**
- Added comprehensive logging throughout the project processing paths to trace where things might be failing

**Issue Discovered - Missing Project Events:**

During testing, discovered that project-related webhooks are not being received:
- Created a new issue → no `issues.opened` event received (may be timing/webhook config)
- Edited issue description → `issues.edited` event received ✓
- Added comment → `issue_comment.created` event received ✓
- Changed issue status in project (moved between columns) → no `projects_v2_item` events received ✗

The absence of project events suggests one of the following:
1. The webhook is not subscribed to `projects_v2` and `projects_v2_item` events in GitHub's webhook settings
2. Projects v2 events may require organization-level webhooks rather than repository-level webhooks (Projects v2 can span multiple repositories)

Next steps: Verify webhook configuration in GitHub settings to ensure `projects_v2` and `projects_v2_item` events are selected. If they're not available at the repository level, we may need to set up an organization-level webhook or use a different approach for project ingestion.

## 2025-11-07: Handling Organization-Level Project Webhooks

### Problem

After further testing, it's clear that GitHub Projects operate at the organization level, even when linked to a specific repository. This introduces a complication: webhooks for project-related events (`projects_v2` and `projects_v2_item`) configured at the organization level do not include the `repository` object in their payload.

This breaks our current ingestion logic, which relies on the repository owner and name to select the correct `GitHubRepoDurableObject` for storing data. We were receiving `400 Bad Request` errors because our webhook handler was rejecting these events due to the missing repository information.

### Solution

To keep the implementation simple and fulfill the goal of "collecting it all," I will implement a strategy to handle these organization-level events gracefully.

1.  **Synthetic Repository for Org-Level Projects**: For `projects_v2` and `projects_v2_item` events that are missing a `repository` object but contain an `organization` object, I will create a synthetic `repository` object in the webhook handler.
2.  **Specialized Durable Object**: This synthetic object will use the organization's login as the `owner` and a special, constant name (`_projects`) as the `repo`.
3.  **Centralized Project Storage**: This change will cause all project-related data for an entire organization to be funneled into a single Durable Object instance, keyed as `<organization_login>/_projects`.

This approach allows us to capture all project data without needing to perform complex and potentially slow API lookups to determine the source repository for each project item. While this centralizes project data, it's a pragmatic solution that can be revisited later if more granular, repository-specific project tracking is required. This would likely involve introducing a configuration mechanism to specify which repositories' project events are of interest. For now, we will collect everything.

This also means that for the system to work correctly with projects, the GitHub webhook must be configured at the **organization level**, not the repository level.

## 2025-11-07: Project Item Processing - Status Update

### Issues Resolved

**Content ID Extraction:**
GitHub sends GraphQL node IDs (e.g., `I_kwDOO_nuS87WfCX7`) for project items instead of simple numeric IDs. Implemented `extractContentId` function that:
- Prioritizes `content_id` if present in payload
- Falls back to parsing numeric ID from base64-encoded `content_node_id` using regex
- Handles edge cases with warning logs

**Foreign Key Constraint:**
Project items can arrive before their parent project records. Added automatic project creation logic that creates a minimal project record when a `projects_v2_item` event arrives for a non-existent project. This prevents foreign key constraint errors while preserving data integrity.

**TypeScript Type Safety:**
Fixed type mismatches where `projectItem.id` could be `string | number` but database schema expects `text`. Added explicit `String()` conversions in all database operations to ensure type consistency.

### Current Status

Project item ingestion is working end-to-end:
- Organization-level webhooks are processed correctly with synthetic repository handling
- Content IDs are extracted successfully from GraphQL node IDs
- Project auto-creation prevents foreign key errors
- Database records are created and versioned correctly
- Markdown files are stored in R2 with proper versioning

**Test Results:**
- `projects_v2_item` events processed successfully (202 Accepted)
- Content ID `7` extracted from node ID `I_kwDOO_nuS87WfCX7`
- Project `PVT_kwDOAq9qTM4BHbYx` auto-created
- Project item record created with version tracking
- Markdown stored at `github-ingest/redwoodjs/_projects/projects/PVT_kwDOAq9qTM4BHbYx/items/issue/7/b0ea2b5b2076b8c1.md`

The GitHub ingestor is now fully operational for all entity types: Issues, PRs, Comments, Releases, Projects, and Project Items.

## 2025-11-07: Revisiting the Backfill Mechanism for Resilience

### Context

The initial plan for the backfill mechanism, while functional, was designed for a "happy path" scenario. Upon review, it became clear that it lacks resilience. For large, active repositories, a single unexpected issue—be it a network flake, a malformed data payload from the API, or a bug in our processing—could cause the entire backfill to fail. Without a way to resume, the only recourse would be to restart the entire job, which is inefficient.

### Revised Architecture: A Resumable, State-Managed Approach

To address these shortcomings, I am redesigning the backfill process to be stateful, pausable, and resumable. This ensures that even if a job is interrupted, it can be restarted from where it left off with minimal manual intervention.

1.  **State Management via Durable Object**:
    -   A new Durable Object, `GitHubBackfillStateDO`, will be created to manage the state of each backfill job.
    -   **Key**: The DO will be keyed by the repository being backfilled (e.g., `owner/repo`).
    -   **State**: The DO will persist the job's `status` (`in_progress`, `paused_on_error`, `completed`) and, critically, the **pagination cursors** from the GitHub API for each entity type being processed.
    -   **State Schema Example**:
        ```json
        {
          "status": "in_progress",
          "currentEntity": "issues",
          "cursors": {
            "issues": "<base64_cursor_string_for_next_page>",
            "pull_requests": null
          },
          "lastError": null
        }
        ```

2.  **Trigger and Paged Execution**:
    -   The `POST /ingestors/github/backfill` endpoint will now function as a job manager.
    -   When triggered, it will load the `GitHubBackfillStateDO` for the target repository. If a job is already `in_progress`, it will return a `409 Conflict`. If it's `paused_on_error`, this call will resume it.
    -   Instead of enqueuing all items at once, the endpoint will fetch just a single page of items from the GitHub API. It will then enqueue jobs for that page, save the `nextPageCursor` to the state DO, and finally enqueue a "continuation" job to trigger the processing of the next page. This creates a resilient chain of smaller work units.

3.  **Automatic Pausing on Failure**:
    -   If an individual item fails processing repeatedly in its queue, the queue's dead-letter handler will catch it.
    -   This handler will update the `GitHubBackfillStateDO`'s status to `paused_on_error` and record the details of the failure. This action breaks the "continuation" chain, effectively pausing the backfill until the issue can be investigated.

4.  **Handling Organization-Level Projects**:
    -   When backfilling a repository, the process will also query for projects associated with that repository.
    -   The processing logic for these projects will correctly use the centralized `_projects` data store. Our existing logic is idempotent, so if the same project is encountered via another repository's backfill, it will not be duplicated.

This revised approach provides the necessary resilience for a production-grade system, ensuring that backfills are robust against transient failures and operational issues.

### Deliberation on Atomicity and Resilience

A key concern raised during planning was how to guarantee atomicity. What if the scheduling process fails halfway through handling a page of data? It might have fetched the primary data but failed on a secondary fetch (like finding related projects), or it might have enqueued some jobs but not all. This could lead to an inconsistent state where data is missed.

The resolution to this problem lies in combining two principles: **idempotent processors** and **retryable schedulers**.

1.  **Idempotency as the Foundation**: The true atomic unit of work is the processing of a single entity (one issue, one PR). Our `process...` functions are designed to be idempotent. When a job to process issue #123 runs, it first checks if the data it is about to write is already present. If the latest version in the database matches the incoming data, the function does nothing and exits gracefully. This is the cornerstone of our resilience strategy. It means we don't need complex logic to "delete halfway state" because running the same job multiple times has the same outcome as running it once.

2.  **Retryable Schedulers**: With idempotent processors, the higher-level scheduling logic can be simpler and more robust. We introduce a two-tiered queue system: a `SCHEDULER_QUEUE` to discover work and a `PROCESSOR_QUEUE` to execute it. The "Scheduler Job" is responsible for fetching a page of data (including any sub-fetches) and enqueueing all the corresponding "Processor Jobs". If this Scheduler Job fails at any point, the queue will automatically retry it from the beginning. It might enqueue duplicate Processor Jobs, but our idempotent design handles this perfectly. The state in the `GitHubBackfillStateDO` is only updated *after* a Scheduler Job completes successfully, ensuring that on retry, it always picks up exactly where it left off.

This two-tiered, idempotent approach ensures that arbitrary runtime failures within the scheduling logic do not lead to data loss or corruption, fully addressing the concern about atomicity.

3.  **Handling Persistent Processor Failures (Dead-Letter Queue)**: The final piece of the resilience puzzle is handling "poison pill" messages—jobs in the `PROCESSOR_QUEUE` that fail repeatedly due to a persistent bug (e.g., a type error). For this, we use a Dead-Letter Queue (DLQ).
    -   After a Processor Job fails its final automatic retry, the queue sends the failed message to a configured DLQ.
    -   A simple worker consumes from this DLQ. Its only job is to parse the failed message, identify the source repository, and update the corresponding `GitHubBackfillStateDO`'s status to `paused_on_error`.
    -   This action immediately halts the backfill for that repository, preventing the Scheduler from enqueuing any more work until the bug is fixed and the job is manually resumed.

### Implementation Plan

Based on the finalized architecture, the plan of action is as follows:

1.  **Review and Ensure Idempotency**: Systematically review all `process...` functions to confirm they are fully idempotent.
2.  **Implement State Management**: Create the `GitHubBackfillStateDO` to manage job status and pagination cursors.
3.  **Implement Two-Tier Queues**:
    -   Define a `SCHEDULER_QUEUE` and a `PROCESSOR_QUEUE` in `wrangler.jsonc`.
    -   Implement the worker logic for the Scheduler Job, which fetches data, performs sub-fetches, and enqueues jobs to the Processor Queue.
4.  **Implement Trigger Endpoint**: Create the `POST /ingestors/github/backfill` route. This endpoint will be a simple trigger that creates the initial Scheduler Job.
5.  **Configure Dead-Letter Queue**: Set up the dead-letter queue for the `PROCESSOR_QUEUE`. Implement the handler that catches failed jobs and updates the `GitHubBackfillStateDO` to pause the backfill.
6.  **Update Configuration**: Add all new DO and Queue bindings to `wrangler.jsonc`.
7.  **Documentation**: Update the `README.md` with instructions on how to use the backfill feature.

### Testing and State Management Strategy

To ensure the backfill mechanism can be tested effectively and managed in production, the following capabilities will be included:

1.  **State Reset for Clean Runs**:
    -   The `POST /backfill` endpoint will be designed to always initiate a *clean* backfill.
    -   When triggered, it will first reset the state in the `GitHubBackfillStateDO` for the given repository, clearing all cursors, statuses, and error messages.
    -   This provides a simple and predictable way to "do it for real" or start over after a partial test or a completed run. A separate `resume` capability is not included in this plan; a fresh start is the intended behavior for a manual trigger.

2.  **Controlled Test Runs**:
    -   The backfill endpoint will accept an optional boolean parameter in its JSON payload: `test_run: true`.
    -   If this flag is present, the backfill process will be limited to a small, predictable slice of work.
    -   The scheduler will fetch only the *first page* of the *first entity type* (issues) and enqueue those jobs. It will then stop and not proceed to the next page or the next entity type.
    -   This allows for a quick end-to-end validation of the entire pipeline—from API fetch to queueing to processing and R2 storage—without waiting for a full repository backfill to complete.

## 2025-11-07: Post-Backfill Review and Architectural Pivot

### Summary of Findings

After the first complete backfill and a review of the synchronized R2 data, several issues became apparent. These range from minor structural and naming inconsistencies to a significant architectural flaw in our versioning strategy. The current implementation, while correctly capturing events, results in fragmented, incomplete, and difficult-to-use data artifacts. A pivot is required to move from an event-centric versioning model to an entity-centric one that maintains a complete, up-to-date record of each object while still preserving its history.

### Analysis of Issues

#### 1. Structural & Naming Issues

*   **Directory Naming**: The top-level directory is named `github-ingest/` instead of the cleaner `github/`. This is a simple string artifact in the R2 key generation logic.
*   **Project Storage Confusion (`_projects` vs. repo-specific)**:
    *   **Cause**: We are correctly routing organization-level webhook events to a synthetic `redwoodjs/_projects` directory. However, the backfill process, when triggered for the `redwoodjs/machinen` repository, fetches *all* organization-level projects and incorrectly associates them with `machinen`, creating the `machinen/projects` directory.
    *   **Impact**: Project data is scattered and incorrectly attributed to a specific repository.
*   **Cryptic Project IDs**: Project directories are named with their GraphQL Node ID (e.g., `PVT_kwDOAq9qTM4BHbYx`). This is the unique identifier returned by the API, but it is not human-readable. The project `number` would be a more intuitive identifier.
*   **Generic "Project Item" Title**: The Markdown for project items has a static title, `# Project Item`, which lacks context. It should describe the item it represents (e.g., the title of the linked issue).

#### 2. Data Association Bug: The `issues/0/comments/` Problem

*   **Cause**: When processing backfilled comments, the logic fails to correctly extract the parent issue or pull request number from the API payload. It appears the payload structure for comments fetched via the REST API list endpoint differs from the webhook payload structure, causing our extractor to find `undefined`, which is then coerced into `0`.
*   **Impact**: A large number of comments are orphaned in a common `.../issues/0/comments` or `.../pull-requests/0/comments` directory, losing their relationship to the parent entity.

#### 3. Fundamental Flaw in Versioning: Data Fragmentation

*   **Cause**: The current strategy creates a new, full Markdown file for *every* event. However, webhook payloads are often partial. An event for a label change on a pull request does not contain the PR's body. Our markdown converter takes this partial data and generates an incomplete file, resulting in many "versions" that lack essential content like a title or description.
*   **Impact**: It is impossible to reliably find the "latest" complete state of an entity. The data is fragmented across dozens of partial files, making it practically unusable for an AI that needs a coherent document. The weird formatting you noted (e.g., duplicated author names) is also a symptom of this, as the markdown converter tries to build a full document from partial data.

### Proposed Architectural Changes: The "Latest State" Model

To fix these issues, I propose a fundamental shift in our strategy. The webhook or backfill event should not be the *source of content*, but merely a *trigger* to fetch the latest, complete state of the entity.

1.  **Introduce `latest.md`**:
    *   For each entity (issue, PR, etc.), we will maintain a single, canonical `latest.md` file (e.g., `github/redwoodjs/machinen/issues/57/latest.md`).
    *   When an event arrives (e.g., `issues.edited`), we will ignore the partial payload and instead make a direct API call to GitHub to fetch the full, current state of that issue.
    *   This complete and up-to-date data will be used to generate and overwrite the `latest.md` file.
    *   **Outcome**: `latest.md` will always be a complete, coherent, and current representation of the entity.

2.  **Move to `history/` for Diffs**:
    *   The concept of versioning is still valuable, but we will no longer store full, fragmented files.
    *   Instead, for each entity, we will create a `history/` subdirectory (e.g., `.../issues/57/history/`).
    *   When an update occurs, we will compare the newly fetched full state against the last known state.
    *   We will generate a "diff" of the changes (e.g., a JSON object showing what fields were modified) and store this diff as a timestamped file in the `history/` directory (e.g., `history/2025-11-07T15-30-00Z.json`).
    *   **Outcome**: The history is preserved in a lightweight, machine-readable format without cluttering the main directory with incomplete files.

3.  **Database Schema Simplification**:
    *   The database will no longer need to track a complex chain of versions. The main entity table (e.g., `issues`) can be simplified to store metadata and perhaps a content hash of the `latest.md` to easily detect if an update is needed. The `issue_versions` table can be repurposed or redesigned to reference the diff files in the `history/` directory.

### Plan of Action

I will pause all other work and focus on implementing this architectural pivot. I will stop after outlining the plan and wait for your approval before making any code changes.

**Phase 1: Analysis and Planning (This Document)**
1.  **Acknowledge Issues**: Parse and understand all reported problems.
2.  **Identify Root Causes**: Investigate the codebase to find the source of each bug and design flaw.
3.  **Propose New Architecture**: Design the `latest.md` + `history/` model.
4.  **Create Action Plan**: Formulate a step-by-step plan for implementation.

**Phase 2: Implementation**

1.  **Codebase Cleanup & Bug Fixes**:
    *   **R2 Path**: In all `getR2Key` utilities, change the base path from `github-ingest` to `github`.
    *   **Comment Processor**: Fix the logic in the backfill processor to correctly parse the parent `issue.number` or `pull_request.number` from the comment API payload.
    *   **Project Backfill**: Modify the `scheduler-service.ts` to route project backfilling to the `_projects` synthetic repository, ensuring data is stored centrally.
    *   **Project Naming**: Update project R2 key generation to use the project `number` instead of the GraphQL `id`.
    *   **Project Item Markdown**: Enhance `projectItemToMarkdown` to fetch and include the title of the linked issue or PR, providing more context than just "Project Item".

2.  **Architectural Refactoring (`latest.md` + `history/`)**:
    *   **Modify Processors**: Overhaul all `process...` functions (`issue-processor`, `pr-processor`, etc.).
        *   On receiving an event, add a step to call the GitHub API to fetch the full entity data.
        *   Update R2 logic to write to a `.../{id}/latest.md` file.
    *   **Implement Diffing**:
        *   In each processor, after fetching the new state, compare it to the previously stored state (this may require reading the old `latest.md` or storing a content hash/previous state in the DO).
        *   Generate a summary of changes (a diff).
        *   Update R2 logic to write the diff to a `.../{id}/history/{timestamp}.json` file.
    *   **Update Database**: Adjust the SQLite schemas to support the new model (e.g., removing the `versions` tables or repurposing them for diffs).

**Phase 3: Validation**
1.  **Full Re-Backfill**: After deployment, we will need to trigger a fresh backfill for the `redwoodjs/machinen` repository.
2.  **Data Deletion**: The old, fragmented data in the `github-ingest` directory will need to be manually deleted from the R2 bucket.
3.  **Verification**: Sync the new `github` directory from R2 locally and verify that the structure is correct, the `latest.md` files are complete, and the `history/` diffs are being generated as expected.
