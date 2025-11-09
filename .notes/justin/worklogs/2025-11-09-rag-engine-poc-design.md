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
        *   **Description:** The first plugin creates a base prompt from the final ranked chunks. Subsequent plugins can then *modify* that prompt (e.g., add system instructions, examples, or formatting).

    *   **`formatFinalResponse`**
        *   **Composition:** Waterfall
        *   **Description:** The first plugin might format the raw LLM output (e.g., into basic Markdown). Subsequent plugins can then enrich it, for example by adding source links and citations to the final object.
