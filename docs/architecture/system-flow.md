# System Flow

This document describes the high-level, end-to-end flow of how data from external sources is ingested, processed, and indexed by the system. The architecture is event-driven, designed to be scalable and resilient.

## High-Level Overview

The system's primary goal is to transform raw data from sources like GitHub into a structured, queryable knowledge base. This knowledge base has two main components:
1.  **The Evidence Locker**: A vector index of fine-grained data chunks, optimized for semantic search to answer "what" questions.
2.  **The Knowledge Graph**: A graph of "Subject" nodes that represents synthesized narratives and relationships, optimized for answering "why" questions.

The flow is designed to be incremental, processing only new or changed information to operate efficiently at scale.

## The End-to-End Flow

The process can be broken down into six key stages, moving from an external event to a fully indexed state.

### 1. Event Trigger

The entire process begins with an event that signifies a change in a source entity. This can be triggered in two ways:
*   **Real-Time Update**: A webhook from a source like GitHub is received by a dedicated ingestion service (e.g., `github-proxy-worker`).
*   **Bulk Backfill**: A manual or scheduled process triggers a backfill job, which queries the source API for a large set of entities.

This event is treated as a **trigger**, not as a source of content.

### 2. State Fetch & Denormalization

Upon receiving a trigger, the ingestion service performs a critical pre-processing step before storing anything.
1.  **Fetch Full State**: It makes a direct API call to the source (e.g., GitHub API) to fetch the complete, current state of the entity. This ensures data completeness, avoiding issues with partial webhook payloads.
2.  **Denormalize**: It assembles a "page-centric" view of the data. Related child entities are embedded within the parent. For example, all comments and reviews are embedded into the JSON for a GitHub Pull Request.
3.  **Write to R2**: The service writes a single, denormalized `latest.json` file for the entity to a Cloudflare R2 bucket.

This stage ensures that the downstream processing pipeline always has the full context of an entity in a single, predictable file.

### 3. Indexing Scheduler Trigger (`R2_EVENTS_QUEUE`)

The write operation to R2 automatically triggers the next stage of the pipeline.
*   R2 is configured with Event Notifications. When the `latest.json` file is written, R2 sends a message containing the object key to a dedicated Cloudflare Queue, `R2_EVENTS_QUEUE`.
*   This queue decouples the initial data ingestion from the more intensive indexing process.

### 4. Indexing Scheduler & Fan-Out (`indexing-scheduler-worker`)

A scheduler worker consumes messages from the `R2_EVENTS_QUEUE`. Its purpose is to act as a gatekeeper, determining the exact work that needs to be done and fanning it out for parallel processing. This is the key to the system's scalability.

1.  **Stateful Diffing**: The worker performs the critical diffing logic. It first checks the document's `etag` against the state stored in `EngineIndexingStateDO`. If the `etag` is new, it splits the document into chunks, calculates their content hashes, and compares them to the list of previously processed hashes, also from the state DO.
2.  **Subject Correlation**: For the set of **new or modified chunks**, the scheduler calls the `determineSubjectsForDocument` plugin hook to assign a `subjectId` to each chunk.
3.  **Fan-Out to Queue**: The scheduler then "fans out" the work. For each new chunk (now containing a `subjectId`), it enqueues a new, specific job onto a second queue, `CHUNK_PROCESSING_QUEUE`. The goal of this fan-out is to enable massive parallelism, allowing many small chunk-processing jobs to run simultaneously instead of one large, slow, sequential job.

### 5. Parallel Chunk Processing (`chunk-processor-worker`)

A pool of workers consumes from the `CHUNK_PROCESSING_QUEUE` in parallel. Each worker is responsible for the expensive, network-bound work of processing a single chunk. The payload of the job is the `Chunk` object itself. The worker performs two main tasks:

1.  **Evidence Locker Update**: It embeds the chunk's content (an AI API call) and inserts the resulting vector into the Vectorize index (the Evidence Locker).
2.  **Knowledge Graph Update**: It uses the `subjectId` on the chunk's metadata to update the corresponding `Subject` in the `SubjectDO`. This typically involves appending the chunk's content to the Subject's `narrative`.

### 6. Final State Update

The final step is performed by the **Indexing Scheduler** after it has successfully enqueued all the jobs for the new chunks.
*   It calls `setProcessedChunkHashes`, which updates the `EngineIndexingStateDO` with the new file `etag` and the complete list of *all* current chunk hashes for the document.
*   This optimistic state update ensures that if the same document is triggered again while its chunks are being processed, the scheduler will correctly see that the work has already been queued and will not enqueue it a second time.
*   Failed chunk processing jobs from the `CHUNK_PROCESSING_QUEUE` are sent to a Dead-Letter Queue (DLQ) for manual inspection, preventing them from blocking the pipeline.
