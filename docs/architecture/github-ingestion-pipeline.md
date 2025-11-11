# GitHub Ingestion Pipeline

## The Challenges

The architecture addresses several core problems, leading with the most critical: structuring the data for its end use in an AI system.

### 1. Data Structure for AI Retrieval

The ultimate purpose of the ingested data is to serve as the knowledge base for a RAG system. This imposes specific requirements on the data's structure that differ from a traditional, normalized database.

A normalized structure—where issues, pull requests, and comments are stored as separate, self-contained documents—is fundamentally incompatible with the operational model of a source-agnostic RAG system. The retrieval mechanism is a vector database, which finds context through semantic similarity, not by executing relational joins.

Such a system cannot be expected to understand the unique data model of every source it ingests. It would not know, for example, that to understand a GitHub pull request, it must also find and assemble all related comment documents. Forcing this source-specific, relational logic onto a vector search is technically infeasible and defeats the purpose of a generalized retrieval system. The data must therefore be denormalized *before* ingestion, structured not as discrete database records, but as "pages" that an AI can consume as a single, pre-joined unit.

### 2. Data Completeness and Consistency

A secondary challenge relates to data completeness and consistency. An approach of simply storing the payload from each webhook event is insufficient for two main reasons:

*   **Partial Payloads**: Webhook payloads are event-specific and often partial. An event for a label change on an issue, for example, does not contain the issue's full description or its comments. Storing these partial payloads directly results in fragmented, incomplete files, which complicates reconstructing an up-to-date view of any given entity.

*   **State Reconciliation**: The system must handle both real-time updates via webhooks and historical backfills via the API. The GitHub API returns the *current state* of an entity, not a historical stream of the events that modified it. This creates a fundamental conflict: a system built to process event streams cannot easily reconcile its state with the entity-based data returned by a backfill.

### 3. Operational Resilience for Backfills

Ingesting the full history of a large, active repository is a long-running, resource-intensive process. A monolithic backfill script is susceptible to failure from transient issues like network flakes, API rate limits, or intermittent processing bugs. Without a mechanism to pause and resume, any failure would require restarting the entire job.

### 4. Handling Atypical, Organization-Level Entities

Not all GitHub entities are neatly contained within a single repository. GitHub Projects (V2), for instance, can operate at the organization level and span multiple repositories. Webhooks for these entities are delivered at the organization level and do not include a `repository` object in their payload. This breaks any ingestion model that is keyed strictly by repository.

## The Architecture

The architecture is a stateful pipeline that uses a denormalized structure, webhooks for real-time updates, and a queue-based system for backfilling. The design is centered on "pages" of content rather than discrete data points.

### 1. A Denormalized, "Page-Centric" Storage Model

To address the needs of the RAG system, the data is stored in a denormalized, "page-centric" format that mirrors how a user would see the information in the GitHub UI.

*   **Embedded Content**: A single `latest.json` file is maintained for each primary entity (Issue, Pull Request, Project). Child entities are embedded directly within their parent's file. For example, the `latest.json` for a pull request contains its full description, followed by a structured array of all its associated comments. This creates a single document that represents the entire conversation in a machine-readable format.

*   **Trigger-Based Updates**: When a child entity is modified (e.g., a comment is edited), the system does not create or update a separate file for the comment. Instead, it triggers a re-processing of the *parent* entity. The parent's full state is re-fetched, the `latest.json` is rebuilt with the updated comment, and the single file is overwritten.

*   **History Diffs**: Versioning is handled by storing diffs. For each primary entity, a `history/` subdirectory is maintained. When an update occurs, the system generates a JSON "diff" of the changes between the new and previous states and stores it as a timestamped file. This creates a machine-readable audit trail of all changes.

### 2. A "Latest State" Ingestion Model

To address the problem of data completeness, the system treats all incoming events (from webhooks or backfills) as **triggers**, not as sources of content.

Upon receiving a trigger for an entity (e.g., an issue was commented on), the system makes a direct API call to GitHub to fetch the full, current state of that entity. This data is then used to generate the stored artifact. The artifact generated by this model contains the full state of the entity at the time of processing, which addresses the inconsistencies between partial webhook payloads and full API responses.

### 3. Queue-Driven Backfill System

The system uses a stateful, queue-driven architecture for backfilling.

*   **State Management**: A Durable Object (`GitHubBackfillStateDO`) tracks the status and progress of each backfill job, persisting the pagination cursors from the GitHub API. This makes the process resumable.

*   **Two-Tier Queues**: The process is split between two queues. A `SCHEDULER_QUEUE` is responsible for fetching pages of entity IDs from the GitHub API and enqueuing jobs for each individual item onto a `PROCESSOR_QUEUE`.

*   **Idempotent Processors**: The workers that consume from the `PROCESSOR_QUEUE` are idempotent. If a job to process an issue is run multiple times, it will produce the same result, preventing data duplication from retries. If a Scheduler Job fails and is retried, it can re-enqueue jobs that may have already been processed.

*   **Dead-Letter Queue (DLQ)**: If a job in the `PROCESSOR_QUEUE` fails repeatedly due to a bug, it is sent to a DLQ. A handler for this queue then updates the state DO to `paused_on_error`, halting the backfill for that repository until the issue is resolved.

### 4. Synthetic Key for Organization-Level Data

To handle organization-level entities like GitHub Projects, the system uses a synthetic key. When a webhook arrives without a `repository` payload but with an `organization` payload, a key is generated using the organization's name and a constant (`_projects`). This directs all organization-level project data to a Durable Object for processing. For the final storage in R2, this path is flattened to the structure `github/{owner}/projects/{number}/`.
