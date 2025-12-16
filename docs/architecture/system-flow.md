# System Flow

This document describes the high-level, end-to-end flow of how data is ingested, processed, and queried. The system is designed as an event-driven pipeline that transforms raw data into a structured knowledge base comprising two main components:

1.  **The Evidence Locker**: A vector index for factual, semantic search (see `evidence-locker-engine.md`).
2.  **The Knowledge Graph**: A graph of "Moments" for narrative synthesis and "why" questions (see `knowledge-synthesis-engine.md`).

## The Data Pipeline

The flow is broken down into five key stages, moving from an external event to a fully indexed state.

### 1. Ingestion & Denormalization
The process begins with an event (webhook or backfill) triggering an ingestion service (e.g., `github-proxy-worker`).
1.  **Fetch**: The service fetches the full, current state of the entity from the source API.
2.  **Denormalize**: It assembles a "page-centric" view (e.g., embedding comments into a PR object).
3.  **Store**: It writes the denormalized JSON file to R2, triggering the next stage via R2 Event Notifications.

### 2. The Scheduler & Diffing Engine
The `indexing-scheduler-worker` consumes R2 events and acts as the gatekeeper.
1.  **Diffing**: Using the `EngineIndexingStateDO`, it checks if the file has changed. It splits the document into chunks and compares their content hashes against the previous state.
2.  **Filtering**: Only **new or modified chunks** are selected for processing. Unchanged chunks are skipped entirely.

### 3. Parallel Chunk Processing (Evidence Locker)
The scheduler fans out the new chunks to the `chunk-processor-worker` via a queue.
*   **Vectorization**: Each worker generates an embedding for its assigned chunk.
*   **Indexing**: The vector and metadata are inserted into the Evidence Locker (Vectorize).

### 4. Knowledge Synthesis (Moment Graph)
Concurrent with chunk processing, the scheduler triggers the Knowledge Synthesis Engine for the document.
1.  **Chunk batching and micro-moment summarization**: The engine batches chunks for performance (token/size caps) and uses an engine-owned summarizer. This summarizer calls a plugin hook (`getMicroMomentBatchPromptContext`) to ensure summaries reflect the source's narrative context (e.g., issue proposal vs. PR changes). Batch outputs are cached so re-indexing only recomputes changed batches.
2.  **Synthesis**: Micro-moments are synthesized by an LLM into higher-level "Macro-Moments." The synthesis prompt uses plugin-provided context (`getMacroSynthesisPromptContext`) to inject source formatting guidance and canonical reference tokens (`mchn://...`) so macro moments can identify their originating entities across sources.
3.  **Graph Update**: Macro-moments are inserted into the Moment Graph with parent relationships. The first macro-moment can attach under an existing moment (Smart Linker) to stitch documents into a shared graph. Root moments are indexed as **Subjects**.

### 5. Query & Retrieval
When a user asks a question, the system first attempts a narrative query path, then falls back to RAG. The query endpoint supports multiple output modes to serve both human users and agentic tools:

-   **Answer Mode** (Default): The system constructs a narrative prompt and calls an LLM to generate a natural language answer.
-   **Brief Mode**: The system returns the raw narrative context (Subject summary + Timeline) as plain text without calling an LLM. This is optimized for agentic clients (like Cursor MCP) that want to perform their own reasoning over the retrieved context.
-   **Prompt Mode**: The system returns the exact prompt that would have been sent to the LLM.

The retrieval logic remains the same regardless of the output mode:

1.  **Identify anchor Moments**: The query is used to find similar Moments in the `MOMENT_INDEX`.
2.  **Resolve Root & Build Timeline**: For matched Moments, the engine resolves the root Subject and retrieves the **full descendant timeline**. This ensures that linked work (like a Discord thread attached to a GitHub issue) is included in the narrative context.
3.  **Fallback to Subject-First**: If there are no matched Moments, the query is used to find relevant Subjects (Root Moments) in the `SUBJECT_INDEX`, then the engine loads that Subject's descendant timeline.
4.  **Fallback to Evidence Locker**: If no narrative context is found, the system falls back to a standard RAG search against the Evidence Locker.

#### Root-to-leaf narrative context (primary retrieval mode)
For cross-document, cross-source timelines, ancestor trails can omit linked descendant work (example: a Discord thread or PR attached under a root, while the query matches a moment higher up in the tree).

The primary retrieval mode for narrative queries is:

1. Identify anchor Moments (vector match against `MOMENT_INDEX`).
2. For each anchor Moment, resolve its root Subject.
3. For each resolved root, traverse descendants and build root-to-leaf paths.
4. Provide the LLM with the full timeline context (capped by token budget) rather than only ancestor trails.

## Architecture Map

*   **Evidence Locker (RAG)**: See `evidence-locker-engine.md` for details on vector indexing and incremental diffing.
*   **Knowledge Synthesis**: See `knowledge-synthesis-engine.md` for details on the Moment Graph, Micro-Moments, and Subject-First querying.
*   **Plugin System**: See `plugin-system.md` for details on the hooks that power these pipelines.
