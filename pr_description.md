# GitHub Ingestor: Architectural Synopsis

## Summary

This work introduces a GitHub ingestor service that provides two primary capabilities: real-time event processing and resilient historical backfilling.

*   **Real-time Event Ingestion**
    *   A secure webhook endpoint, `POST /ingestors/github/webhook`, was created to receive live events from GitHub for entities such as Issues, Pull Requests, Comments, Releases, and Projects.
    *   Incoming requests are authenticated using HMAC-SHA256 signature verification to ensure they originate from GitHub.
    *   Upon receiving an event, the service fetches the full, current state of the entity from the GitHub API. This complete data is stored as a canonical `latest.md` file in R2, ensuring a consistent and up-to-date record. A history of changes is preserved as lightweight diffs.
    *   The system handles organization-level data (like Project V2 events), which are not tied to a single repository, by routing them to a shared, central data store for the organization.

*   **Historical Backfill**
    *   A triggerable endpoint, `POST /ingestors/github/backfill`, was developed to ingest the complete history of a repository.
    *   The process is designed for resilience, using a queue-based system to break the backfill into small, independent jobs. This allows the process to be resumable and robust against transient errors.
    *   A dedicated state manager tracks the progress of each backfill, allowing it to pick up where it left off if interrupted.

## Architectural Decisions

### Maintaining a Coherent State from an Event Stream

A significant challenge with ingestion systems is that event sources, like webhooks, often provide only partial data. An event for a label change on an issue, for instance, might not include the issue's full description.

One possible approach is to store every incoming event payload as a distinct version. This creates a raw, immutable log of events. However, this path presents a few difficulties. Reconstructing the complete, current state of an entity would require replaying its entire event history, which can be inefficient. More importantly, it complicates backfilling, as APIs typically provide the *current state* of an entity, not its historical event log. Merging a backfilled "current state" with a real-time stream of "event versions" could lead to an inconsistent and complex data model.

To address this, the chosen architecture treats an incoming event not as the source of content, but as a *trigger for a state update*.

When an event is received, the system queries the GitHub API to fetch the full, canonical state of the affected entity. This complete data is then used to update a single, canonical file for that entity (e.g., `latest.md`). This approach intends to ensure that there is always a complete, up-to-date representation of each entity available.

To preserve the history of changes, the system can compare the newly fetched state with the previously stored version before updating it. From this comparison, a lightweight diff (e.g., a JSON object) can be generated and stored separately. This seems to offer a reasonable balance, providing a full history of modifications without the data fragmentation that comes from storing incomplete event payloads as full documents.

### A Resilient Mechanism for Backfilling Data

Any real-time ingestion system needs a way to backfill historical data and reconcile its state with the source of truth, accounting for periods of downtime or missed events.

A simple, monolithic script could perform this backfill, but for large repositories, such a process might be brittle. A single transient network error or a problematic data item could cause the entire job to fail, requiring a full restart.

A more resilient approach appears to be a queue-based system that breaks the large task into a series of small, independent, and retryable jobs. The backfill process is managed by a component that tracks its progress. Instead of fetching all items at once, it fetches a single page of items, dispatches a job for each item, and then enqueues a continuation task to handle the next page.

This design allows the process to be paused and resumed. The processing of each individual item is designed to be idempotent, meaning if the same job runs multiple times due to retries, it will not result in duplicate data.

To handle items that consistently fail to process—perhaps due to a bug or unexpected data format—a dead-lettering mechanism can be used. After several failed attempts, a problematic job is moved to a separate queue. This isolates the failing item and allows the rest of the backfill to proceed, preventing a single "poison pill" message from halting the entire system. This seems to provide a more stable foundation for handling large-scale data ingestion.

## Other Decisions and Rationale

#### Webhook Security using HMAC Signatures

For authenticating incoming webhooks, an HMAC-based signature verification approach was chosen over a simple bearer token. GitHub signs its webhook payloads using a shared secret. Our endpoint verifies this signature to confirm the request is authentic and that the payload has not been tampered with. This is a more secure pattern than a bearer token, as the secret itself is never transmitted over the network. The implementation uses the native Web Crypto API for compatibility with the Cloudflare Workers environment.

#### Data Format: Markdown with YAML Front Matter

The decision was made to store ingested data as Markdown files containing YAML front matter. This hybrid format seems to serve two purposes well. The front matter provides a structured, machine-readable block for metadata (like IDs, states, and timestamps), which can be parsed without processing the entire document. The body of the file remains as human-readable Markdown, preserving the original content in a clean format.

#### Simplified Configuration

To simplify the setup process for users, the ingestor was designed to reuse the existing `INGEST_API_KEY` for webhook signature verification. Instead of requiring a separate `GITHUB_WEBHOOK_SECRET`, users can provide the same key value in their GitHub webhook configuration. This reduces the number of secrets that need to be managed.

#### Versioning State Changes

It was decided that not only content edits but also state changes should create a historical record. Events like closing a pull request, merging it, or pushing new commits (a `synchronize` event) are treated as significant moments in an entity's lifecycle. Capturing these as distinct versions (via history diffs) provides a more complete timeline of how an entity evolved.
