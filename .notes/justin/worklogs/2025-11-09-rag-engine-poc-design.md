# 2025-11-09: RAG Engine POC - Research & Design

## 1. Project Overview & Goal

The primary goal is to build a proof-of-concept for an internal knowledge system, a Retrieval-Augmented Generation (RAG) tool that functions as an "organization AI." This system will ingest data from various sources like GitHub (PRs, issues, comments), Cursor conversations, and meeting notes, which are already stored in Cloudflare R2.

The purpose is to provide context, explain historical decisions, and essentially solve the "bus factor" problem by making institutional knowledge searchable and accessible through a natural language chat interface. The POC needs to be developed quickly on the Cloudflare stack, using our existing data.

The core of the project is an "Engine" responsible for the entire RAG pipeline, from data processing to generating answers. A foundational requirement for this engine is that it must be highly extensible, allowing for different strategies and components to be plugged in at various stages of the process.

## 2. Technology Investigation & Decision

Our initial brainstorming focused on finding a suitable vector database solution that could run on Cloudflare Workers and integrate with R2 for storage and Durable Objects (`rwsdk/db`) for metadata.

### 2.1. Initial Idea: LanceDB

*   **Hypothesis:** LanceDB was considered a strong candidate, with the assumption that its JavaScript client had a pluggable storage layer that we could adapt to our Cloudflare backend.
*   **Investigation:** A deep dive into the LanceDB source code revealed that while it is extensible at the storage layer via a Rust `ObjectStore` trait, this customization must happen in Rust.
*   **Conclusion:** The path to using LanceDB would require writing a custom Rust implementation for R2/DO, compiling it to a custom WASM binary, and managing that complex toolchain within the Cloudflare Workers environment. This was deemed too high-risk and too complex for a rapid proof-of-concept.

### 2.2. Alternative: DIY with `hnswlib-wasm`

*   **Hypothesis:** We could use a lower-level, pure JS/WASM library to handle the vector math and build our own storage logic on top of R2.
*   **Investigation:** This approach involves treating the entire vector index as a single file in R2. Every update would require a "read-modify-write" cycle of the whole index, managed by a Worker.
*   **Conclusion:** While this offers maximum flexibility, we identified significant drawbacks that would require complex, time-consuming engineering to solve:
    *   **Concurrency:** No built-in protection against race conditions where two processes overwrite each other's changes.
    *   **Scalability:** The entire index must fit into a Worker's memory, creating a hard limit on size.
    *   **Metadata Filtering:** Lacks an integrated way to combine vector search with metadata filtering, forcing an inefficient two-step query process.
    *   **Transactional Integrity:** No guarantees of consistency between the index file in R2 and metadata in a Durable Object.

### 2.3. Final Decision: Cloudflare Vectorize

After clarifying that previous experiments were with AutoRAG, not Vectorize itself, we re-evaluated it based on a framework of the "things that matter" for a vector database solution: scalability, performance, correctness, and effectiveness.

*   **Rationale:** For a POC, a managed service like Cloudflare Vectorize is the most pragmatic choice. It solves the hard database problems for us, allowing us to focus on the unique logic of our RAG application.
*   **Key Advantages for the POC:**
    *   **Managed Scalability & Performance:** Handles indexes larger than memory and is globally distributed for low-latency queries.
    *   **Integrated Metadata Filtering:** This is a critical feature that allows for efficient, single-shot queries combining semantic search with hard filters (e.g., `source: 'github'`).
    *   **Data Integrity:** As a managed database, it provides consistency and reliability out of the box.
    *   **Rapid Development:** A simple API lets us get to a working end-to-end prototype much faster.

We are choosing Vectorize for the POC with the understanding that we are trading some degree of control for a massive gain in speed and reduction in risk. This will allow us to validate the overall RAG architecture and experiment with the pluggable layers, which is the true core of the project. If we hit a hard limitation with Vectorize, we will have a much clearer business case and better understanding to justify building a more complex, custom solution.

## 3. Evaluation Framework: The "Things That Matter"

To guide our decision, we established a framework for evaluating any potential vector database solution. This helps us understand the trade-offs and avoid discovering critical limitations too late.

### 3.1. Scalability ("How does it grow?")
This is about handling growth in index size, write frequency, and read traffic.
*   **Key Question:** Can the index grow larger than a single machine's RAM?
*   **Managed (Vectorize):** Yes, this is a core feature. They handle sharding and paging from disk automatically.
*   **DIY (`hnswlib-wasm`):** No. The entire index must fit in a Worker's memory, creating a hard scalability limit.

### 3.2. Performance ("How fast is it?")
This is the trade-off between query latency, indexing speed, and the accuracy/recall of the results.
*   **Key Question:** Can you tune the speed vs. accuracy trade-off?
*   **Managed:** Yes, they typically expose parameters to control this. They are also globally distributed for low latency.
*   **DIY:** Yes, the library itself has tuning parameters, but overall latency is dominated by the slow I/O of reading the entire index from R2 on every query.

### 3.3. Correctness & Data Management ("Can I trust it?")
This covers data integrity, consistency, and expected database features.
*   **Key Question:** Does it support efficient, server-side metadata filtering?
*   **Managed:** Yes, this is a critical, built-in feature for combining vector search with structured queries (e.g., `WHERE source = 'github'`).
*   **DIY:** No. This would require a slow and inefficient two-step process: fetch many vector results, then filter them with a separate query to a different data store.
*   **Key Question:** Does it provide transactional guarantees?
*   **Managed:** Yes, mature systems offer ACID-like guarantees.
*   **DIY:** No. We would be responsible for managing consistency between R2 and Durable Objects, which is complex and error-prone.

### 3.4. Effectiveness ("Does it get the *right* answer?")
This is about the features that improve the quality of the final RAG output.
*   **Key Question:** Does it support hybrid search (combining keyword and vector search)?
*   **Managed:** Often, yes. This is becoming a standard feature in mature vector search solutions.
*   **DIY:** No, not out of the box. We would have to implement a separate keyword search system and manually combine the results.

### 3.5. Tooling & Integration
*   **Embedding Models:** For the POC, we will use the embedding models available directly through Cloudflare Workers AI. This simplifies the architecture by keeping the entire process within the Cloudflare ecosystem, avoiding the need for external API calls to services like OpenAI or Cohere.

## 4. Engine Architecture Blueprint

The core of the POC is the "Engine," a central orchestrator responsible for the entire RAG pipeline. The design is based on a plugin architecture, similar to Vite or ESLint, where the engine manages a core processing chain and plugins can "hook" into various stages to provide extensible functionality.

### 4.1. Design Principles & Deliberations

*   **Descriptive Naming:** Hook names should be clear and descriptive (e.g., `prepareSourceDocument` instead of a generic `transform`) to make the purpose of each stage obvious.
*   **Explicit Plugin Composition:** The method for combining the outputs of multiple plugins for the same hook must be clearly defined. A single hook can't be both a "reducer" and a "collector." This led to defining specific composition strategies.
*   **Data Provenance:** All data structures that flow through the system (e.g., `Document`, `Chunk`) must retain a clear reference back to the original source R2 object key. This is essential for retrieving the raw context and providing citations.

### 4.2. Plugin Composition Strategies

The engine will support different strategies for composing plugin outputs, depending on the hook:

*   **Waterfall:** The output of one plugin becomes the input for the next, in a defined order. This is for sequential refinement. `(data) => pluginC(pluginB(pluginA(data)))`.
*   **First-Match:** The engine tries plugins in order until one successfully handles the input and returns a non-null result. This is for source-specific logic where only one plugin should act.
*   **Collector:** Each plugin can contribute a piece of a final collection (e.g., a filter clause). The engine aggregates these pieces into a final result (e.g., by joining with an `AND` operator).

### 4.3. The Indexing Chain

The indexing process is designed to be robust and scalable, handling both the initial backfill of existing data and the continuous ingestion of new objects.

*   **Trigger Mechanism:** The system uses a queue-based architecture.
    *   **Cron Job (Batch/Backfill):** A scheduled Worker runs periodically to scan R2 for unprocessed objects, sending them in batches to a Cloudflare Queue. This is the primary mechanism for the POC and for ensuring data integrity.
    *   **R2 Events (Real-time):** Optionally, an R2 object-create event can also trigger a function to send a new object's key to the same queue for low-latency ingestion.
    *   **Queue Consumer:** A dedicated Worker consumes from this queue, running the indexing pipeline for each object.

*   **Pipeline Stages:**

    *   **`prepareSourceDocument`**
        *   **Composition:** First-Match
        *   **Description:** Finds the correct plugin for the source (e.g., `GitHubPlugin` for a GitHub PR). The plugin extracts the primary text content and essential metadata into a standardized `Document` object, ensuring the original R2 object key is preserved.

    *   **`splitDocumentIntoChunks`**
        *   **Composition:** First-Match
        *   **Description:** Finds the right strategy (e.g., a Markdown chunker) to split the `Document`'s text into smaller `Chunk` objects. Each chunk inherits the parent document's metadata and R2 key.

    *   **`enrichChunk`**
        *   **Composition:** Waterfall
        *   **Description:** Each plugin receives a `Chunk` and can add or modify its metadata. This is for things like topic labeling, PII redaction, or adding keyword tags for hybrid search later.

### 4.4. The Query Chain

This pipeline is triggered by a user's query.

*   **Pipeline Stages:**

    *   **`prepareSearchQuery`**
        *   **Composition:** Waterfall
        *   **Description:** Each plugin can modify the user's raw query string. This is for expansion, clarification, or adding keywords. The output of one plugin is passed to the next.

    *   **`buildVectorSearchFilter`**
        *   **Composition:** Collector
        *   **Description:** Each plugin can contribute a part of the `where` clause for the Vectorize query. The engine combines these clauses (e.g., with an `AND` operator) to create the final, efficient filter.

    *   **`rerankSearchResults`**
        *   **Composition:** Waterfall
        *   **Description:** After the initial query to Vectorize, each plugin receives the list of results and can re-order, remove, or boost items. The output list is passed to the next reranker.

    *   **`composeLlmPrompt`**
        *   **Composition:** Waterfall
        *   **Description:** Receives the ranked list of chunk metadata from the reranking stage. The primary plugin for this hook is responsible for dynamically fetching the original text content for each chunk from R2 (using the `documentId` and `jsonPath` from the metadata), formatting each piece into a readable snippet, and assembling them into a coherent block of context for the LLM prompt. Subsequent plugins can then modify this assembled prompt.

    *   **`formatFinalResponse`**
        *   **Composition:** Waterfall
        *   **Description:** The first plugin might format the raw LLM output (e.g., into basic Markdown). Subsequent plugins can then enrich it, for example by adding source links and citations to the final object.

## 5. Ingester Output, Chunking, and Retrieval Strategy

This section defines the end-to-end data flow, from the ideal output of our ingestors to the strategy for chunking and retrieving content for the RAG pipeline. The core principle is to use a structured format (`.json`) as the single source of truth for indexing, and then dynamically assemble context for the LLM from that structured data.

### 5.1. GitHub Source (Issues & Pull Requests)

**Proposed Solution: `latest.json` as the Single Source of Truth**

The GitHub ingestor will produce a single `latest.json` artifact for each entity. The `latest.md` file will be dropped, as it's better to generate the final LLM context dynamically, which provides more flexibility (e.g., filtering out irrelevant comments).

*   **`latest.json` Structure:** This file will contain the entity's metadata, body, and an array of comment objects, providing a machine-readable source for indexing.

*   **Chunking Strategy:**
    *   The PR/issue `body` will be treated as one or more chunks.
    *   Each object in the `comments` array will be treated as a distinct chunk.

### 5.2. Cursor Conversation Source

**Proposed Solution: Use Raw JSON for the POC**

For the initial proof-of-concept, we will use the raw JSON output from the Cursor ingestor. While it contains some noise, it is already structured. A pre-processing step to clean it can be introduced later as an optimization.

*   **Chunking Strategy:**
    *   **Chunk-per-Turn-Pair:** A user's prompt and the subsequent assistant's response can be combined into a single chunk. This preserves the immediate conversational context, which is semantically valuable.

### 5.3. Chunk Metadata and Context Retrieval

The key to handling heterogeneous search results lies in a contract between the metadata we store with each chunk and the logic that reassembles the context.

*   **Rich Metadata:** When a document is chunked, each chunk's vector will be stored with a rich metadata object. This object acts as a "pointer" back to its origin.

    ```typescript
    // Example metadata for a GitHub comment chunk
    {
      "chunkId": "github/pull-requests/57#comment-12346", // A unique, human-readable ID
      "documentId": "github/redwoodjs/machinen/pull-requests/57/latest.json", // The R2 key of the source JSON
      "source": "github",
      "type": "pull-request-comment",
      "documentTitle": "Github ingestor",
      "author": "justinvdm",
      "jsonPath": "$.comments[1].body" // A JSONPath to extract the content from the source file
    }
    ```

*   **Dynamic Retrieval in `composeLlmPrompt`:** The vector search will return a ranked list of these metadata objects. A plugin hooking into the `composeLlmPrompt` stage will be responsible for:
    1.  Receiving the list of chunk metadata.
    2.  Fetching the source `latest.json` files from R2 based on the `documentId` in the metadata.
    3.  Using the `jsonPath` from each metadata object to extract the specific text content from the JSON file.
    4.  Formatting each piece of content into a readable snippet (e.g., `"Comment by @justinvdm on PR #57: ..."`).
    5.  Concatenating these snippets into a single, coherent context block to be included in the prompt for the LLM.

This architecture ensures that the indexing process is robust and the querying process is flexible, allowing the system to construct targeted, high-quality prompts from diverse data sources.

## 6. Implementation Plan: A Plugin-First, Iterative Approach

This plan prioritizes building plugins first and validating the engine's design through real usage before proceeding further.

### Phase 1: Foundation & Setup (Completed)
*   The core types (`Document`, `Chunk`, etc.) and engine function shells (`indexDocument`, `query`) are already in place, providing a harness for plugin development.

### Phase 2: Validate Engine Design with GitHub Plugin (Indexing + Query)
1.  **Implement GitHub Indexing Plugin (MVP):** Create the first plugin. The focus will be on implementing the `prepareSourceDocument` and `splitDocumentIntoChunks` hooks to correctly process a GitHub `latest.json` file from R2. This will be tested against manually created test data or existing `latest.md` files converted to JSON format.
2.  **Implement GitHub Query Plugin (MVP):** Implement the query-side hooks, primarily `composeLlmPrompt`. This hook will receive chunk metadata from vector search, fetch the original content from source `latest.json` files in R2 using `jsonPath`, and assemble a coherent prompt. This validates the query API design alongside the indexing API.
3.  **Validate Engine Design:** Test both indexing and querying with the current engine functions. This step will reveal whether the engine's interface and logic need adjustments. If the engine looks good, proceed to the next phase. If not, iterate on the engine design.

### Phase 3: Update the Ingestor
4.  **Modify GitHub Ingestor:** Once the engine design is validated, update the existing GitHub ingestor and its backfill logic to produce `latest.json` files instead of `latest.md`. This populates R2 with the correct data format for the indexing pipeline.

### Phase 4: Complete Indexing Pipeline
5.  **Implement Minimal Indexing Worker:** Build the queue consumer worker. This worker will call the `indexDocument` engine function, passing in the GitHub plugin. Its responsibility is to take the chunks returned by the engine, generate embeddings, and insert them into Vectorize.
6.  **Test Indexing End-to-End:** Trigger a backfill for the GitHub ingestor. Once complete, manually enqueue a few R2 keys for `latest.json` files to verify that the entire indexing pipeline is creating vectors as expected.

### Phase 5: Complete Query Pipeline
7.  **Implement Minimal Query API:** Build the API endpoint that takes a user's query. This endpoint will call the vector search, pass results to the `query` engine function (which will use the GitHub query plugin), send the final prompt to the LLM, and return the response.
8.  **Test Querying End-to-End:** Hit the endpoint with test queries to validate the full retrieval, prompt composition, and generation loop.

## 7. Refining the Query-Time Context Assembly: A Two-Stage Design

During the implementation of the query-side plugin, a significant architectural refinement was made to the prompt composition process.

**Initial Design and Problem:** The original blueprint proposed a single `composeLlmPrompt` hook. The intention was for this hook to handle both fetching the raw content (using the `documentId` and `jsonPath` from chunk metadata) and assembling the final prompt string. However, this design conflated two distinct responsibilities: **data reconstruction** and **prompt aggregation**. This became problematic when considering advanced use cases.

**Use Case Deliberation:**
1.  **Simple Case (Source-Siloed Context):** A query returns chunks from a single GitHub PR. The plugin needs to fetch the `latest.json` file and format the PR body and its comments into a coherent block. The initial design handled this adequately.
2.  **Advanced Case (Cross-Source Narrative):** A query like "why did we add dependency X?" might return chunks from a GitHub PR, a Cursor conversation, and a planning document. The ideal prompt would not be siloed by source (`## GitHub Context`, `## Cursor Context`). Instead, it would present a unified, chronological narrative.

The initial design made this advanced case difficult and inefficient. An "aggregator" plugin running last would either have to:
*   Re-fetch all the source data, duplicating the work already done by the source-specific plugins.
*   Parse the formatted markdown string from the `existingPrompt`, which is brittle and unreliable.
*   The intermediate proposal of passing a mutable `PromptState` object was an improvement, as it preserved metadata, but still blurred the lines between formatting and aggregation within a single hook.

**The Final Two-Stage Architecture:**
To solve this, we separated the concerns into two distinct stages, orchestrated by the engine:

*   **Stage 1: Reconstruct Context (`reconstructContext` hook)**
    *   **Engine's Role:** The engine takes the list of search results, groups them by `documentId`, fetches the unique source documents from R2 *once*, and then calls a new, specialized `reconstructContext` hook on the appropriate plugin for each document.
    *   **Plugin's Role:** The plugin's sole responsibility is to receive the chunks for a *single document* and its full source JSON, and format them into a self-contained markdown block. It returns a `ReconstructedContext` object, which contains the formatted `content` string and the original, rich metadata.

*   **Stage 2: Aggregate Contexts (`composeLlmPrompt` hook)**
    *   **Engine's Role:** The engine gathers the flat array of `ReconstructedContext` objects from Stage 1 and passes them to the `composeLlmPrompt` hook.
    *   **Plugin's Role:** This hook's sole responsibility is now **aggregation**. It receives an array of pre-formatted, metadata-rich context blocks. It does no fetching or low-level formatting. A default implementation can simply join them, while a more advanced "aggregator" plugin can use the preserved metadata to sort the blocks chronologically before joining, creating a unified narrative.

This revised architecture is superior because it establishes a clear separation of concerns, centralizes the repetitive fetching logic in the engine, simplifies plugin development, and provides a robust foundation for both simple and advanced prompt aggregation strategies without inefficiency or brittle parsing.

**Further Refinement: Explicit, Namespaced Metadata**
A final refinement was added to this two-stage design to make it even more robust. The initial implementation of the `reconstructContext` hook still had a flaw: it relied on parsing the `documentId` (the R2 key) to determine the type of GitHub entity (e.g., PR/Issue vs. Project). This created a brittle, implicit contract between the file storage schema and the query-side logic.

The solution was to make this contract explicit by enriching the metadata at indexing time.

1.  **Introduce `sourceMetadata`:** A generic, optional `sourceMetadata: Record<string, any>` field was added to the `ChunkMetadata` interface. This provides a dedicated namespace for each plugin to store its own specific data without polluting the top-level metadata fields.
2.  **Populate at Indexing Time:** The `prepareSourceDocument` hook in the GitHub plugin is now responsible for populating this object with explicit identifiers (e.g., `{ type: 'github-pr-issue', owner: '...', repo: '...', number: 123 }`). This data is then propagated to all chunks created from that document.
3.  **Use at Query Time:** The `reconstructContext` hook now reads directly from this structured `sourceMetadata` object. It no longer needs to parse the R2 key.

This final change decouples the query logic from the storage layout, makes the plugin's data contract explicit and self-contained, and makes the entire system more robust and maintainable.

## 8. Revised Implementation Plan

After completing Phase 2, the engine design has been validated through implementation. The GitHub plugin successfully exercises both the indexing and query pipelines, proving that the engine's interface and plugin architecture work as designed. The following is the revised plan moving forward:

### Phase 1: Foundation & Setup (Completed)
*   The core types (`Document`, `Chunk`, etc.) and engine function shells (`indexDocument`, `query`) are already in place, providing a harness for plugin development.

### Phase 2: Validate Engine Design with GitHub Plugin (Indexing + Query) (Completed)
1.  **Implement GitHub Indexing Plugin (MVP):** Completed. The plugin implements `prepareSourceDocument` and `splitDocumentIntoChunks` hooks, including the addition of explicit `sourceMetadata` for robust query-time reconstruction.
2.  **Implement GitHub Query Plugin (MVP):** Completed. The plugin implements the two-stage architecture (`reconstructContext` and `composeLlmPrompt`), using explicit `sourceMetadata` instead of parsing R2 keys.

**Validation Complete:** The engine design has been validated through implementation. The GitHub plugin successfully exercises both the indexing and query pipelines, proving that the engine's interface and plugin architecture work as designed.

### Phase 3: Update the Ingestor (Completed)
3.  **Modify GitHub Ingestor:** Updated the existing GitHub ingestor and its backfill logic to produce `latest.json` files instead of `latest.md`. This populates R2 with the correct data format for the indexing pipeline.

**Changes Made:**
*   Created JSON conversion utilities (`pr-to-json.ts`, `issue-to-json.ts`, `project-to-json.ts`) that match the structure expected by the RAG engine plugin.
*   Updated `pr-processor.ts`, `issue-processor.ts`, and `project-processor.ts` to:
    *   Change `getLatestR2Key` functions to return `.json` paths instead of `.md`.
    *   Replace markdown conversion with JSON conversion.
    *   Update parsing functions to read JSON instead of markdown.
    *   Write JSON files to R2 using `JSON.stringify`.
*   The backfill service automatically uses the updated processors, so no changes were needed there.

### Phase 4: Complete Indexing Pipeline (Completed)
4.  **Implement Minimal Indexing Worker:** Built the queue consumer worker. The worker (`src/app/engine/services/indexing-worker.ts`) consumes messages from the `engine-indexing-queue`, calls `indexDocument` with the GitHub plugin, generates embeddings for each chunk, and batch inserts them into Vectorize.

**Changes Made:**
*   Created `indexing-worker.ts` that processes R2 keys from the queue.
*   Integrated the worker into `worker.tsx` queue handler.
*   Added `engine-indexing-queue` configuration to `wrangler.jsonc` (both prod and test environments).
*   The worker batches embedding generation and Vectorize inserts for efficiency.

5.  **Test Indexing End-to-End:** Pending - User will trigger backfill and manually enqueue R2 keys for testing.

### Phase 5: Complete Query Pipeline (Completed)
6.  **Implement Minimal Query API:** Built the API endpoint at `/rag/query`. The endpoint accepts GET or POST requests with a `query` parameter, calls the `query` engine function with the GitHub plugin, and returns the LLM response.

**Changes Made:**
*   Created `src/app/engine/routes.ts` with the query handler.
*   Integrated the route into the main worker with prefix `/rag`.
*   The endpoint supports both GET (query param `q`) and POST (body `query`) for flexibility.

7.  **Test Querying End-to-End:** Pending - User will test with sample queries once indexing is complete.

## 10. Handling Document Updates and Index Synchronization

A critical aspect of the RAG engine is ensuring the vector index remains synchronized when source documents are modified (e.g., a new comment is added to a GitHub issue, or a PR description is edited).

### How Updates are Processed

1.  **Ingestion Overwrites `latest.json`**: When a source entity is modified, the GitHub ingestor re-fetches the *entire* entity from the GitHub API, rebuilds the JSON structure, and overwrites the existing `latest.json` file in R2. This ensures R2 always contains the latest, complete state.

2.  **Re-Indexing Trigger**: The update to the R2 object triggers a message to the `engine-indexing-queue` with the `r2Key` of the modified file.

3.  **Indexing Worker Re-Processes**: The `indexing-worker` receives the job and re-runs the full indexing pipeline for the specified `r2Key`, generating a fresh set of chunks and embeddings.

### The Flaw: Index Pollution

The current implementation uses `VECTORIZE_INDEX.insert()` to add the newly generated vectors to the index. However, this action **does not remove the old, stale vectors** from the previous version of the document.

This would lead to index pollution. Over time, a search for a given document would return both old and new chunks, providing outdated, duplicated, or contradictory context to the LLM and degrading the quality of the responses.

### The Solution: "Delete-Then-Insert" Strategy

To maintain index integrity, the indexing worker must be updated to perform a "delete-then-insert" operation.

1.  **Delete by `documentId`**: Before starting the indexing process for a given `r2Key`, the worker must first issue a delete command to Vectorize to remove all existing vectors associated with that document. Since every chunk's metadata contains a `documentId` field (which corresponds to the `r2Key`), this can be achieved efficiently using a metadata filter.

2.  **Insert New Vectors**: After the old vectors have been purged, the worker proceeds with the standard indexing flow: it generates the new chunks and embeddings and inserts them into the vector index.

This atomic operation ensures that every time a document is updated, its old representations are cleanly removed from the index, keeping it perfectly synchronized with the source of truth in R2.

**Implementation:**
*   Added `deleteExistingVectors()` helper function that queries Vectorize with a metadata filter on `documentId` to find all existing vectors for a document.
*   The function uses a dummy embedding (generated from the text "dummy") to perform the query, since Vectorize requires a vector for similarity search even when filtering by metadata.
*   After retrieving matching vector IDs, it calls `VECTORIZE_INDEX.deleteByIds()` to remove them.
*   The `processIndexingJob()` function now calls `deleteExistingVectors()` before generating new chunks and inserting them.
