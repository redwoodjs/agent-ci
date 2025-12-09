# Work Log: Moment Graph Refactor (Bicycle Iteration)

**Date:** 2025-12-09

## 1. Goal: Refactor to a `Moment Graph`

The "Skateboard" iteration successfully implemented an end-to-end system based on a flat list of `Subject`s. The goal of this "Bicycle" iteration is to refactor the core architecture to a more expressive **`Moment Graph`**, which can capture the rich, evolving, and causal relationships between pieces of information.

A "Subject" will remain the primary conceptual entity, defined by a **root `Moment`** in the graph. All `Moment`s descending from that root collectively form the story of that Subject.

## 2. The Iterative "Bicycle" Plan

The refactoring will be executed in three distinct, end-to-end functional steps. Each step will build upon the last, culminating in a sophisticated graph-based system.

---

### Iteration 1: The Basic Chain (Cursor Only)

*   **Goal:** Establish the minimum viable `Moment Graph` using **Cursor conversations** as the test subject. The focus is on getting the new data structures, database module, and pipeline in place, proving we can build and retrieve a simple, linear chain of moments from a **single document**.
*   **Correlation Strategy:** A simplified version of **Layer 2 (Contextual Affinity)**. We will assume all moments extracted from one document during a single indexing run are causally linked in sequence.
*   **Data Source:** Cursor conversations only. Other data sources (GitHub, Discord, Default) will be implemented in later iterations after we validate the concept.
*   **Tasks:**
    1.  **Define Core Types:** Create the `Moment` and revised `Subject` types in `types.ts`. Update `ChunkMetadata` to use `momentId`.
    2.  **Create `momentDb` Module:**
        *   Create the `MomentGraphDO` as an internal implementation detail.
        *   Create a `momentDb` module that exports **static, functional methods** for interacting with the DO (e.g., `addMoment(db, moment)`, `findAncestors(db, momentId)`). The `db` object will be created in the engine and passed to these functions.
    3.  **Update Plugin API:** In `types.ts`, add `subjects.extractMomentsFromDocument` hook alongside existing hooks.
    4.  **Implement Cursor Plugin:** The Cursor plugin will implement `extractMomentsFromDocument` to extract moments from each generation (user prompt + assistant response).
    5.  **Implement Simplified Ingestion:** The `indexDocument` function will call the new plugin hook. For the list of moments returned from a single document, it will chain them together sequentially (the first becomes a root, the second is a child of the first, etc.).
    6.  **Implement Basic Querying:** Implement the `/timeline` endpoint. The handler will find the *last* moment associated with a document and call `findAncestors` to retrieve the full chain.
*   **Validation:** Ingest a single Cursor conversation with multiple generations. A query about that conversation must return a single, ordered timeline of moments: `[Generation 1] -> [Generation 2] -> [Generation 3]`.

---

### Iteration 2: The Smart Linker

*   **Goal:** Introduce intelligent, **cross-document linking** using semantic search. This step solves the core "tree-shaking -> barrel files" problem where two documents are related by topic but not by explicit reference.
*   **Correlation Strategy:** Implement **Layer 3 (Semantic Search)** as the primary method for finding parent moments.
*   **Tasks:**
    1.  **Enhance `momentDb`:** Add a vector index to the `MomentGraphDO` and expose a `findSimilarMoments(db, vector)` function in the `momentDb` module.
    2.  **Upgrade Ingestion Logic:** The `indexDocument` function will be enhanced. When a new moment is processed, the engine will first call `findSimilarMoments` to search for a parent across the *entire existing graph*. If a suitable parent is found, it will link to it; otherwise, it will create a new root moment.
    3.  **Upgrade Querying Logic:** The `/timeline` endpoint handler will now use `findSimilarMoments` on the user's query to find the best entry-point into the graph before calling `findAncestors`.
*   **Validation:** Ingest a "tree-shaking" document, creating a root moment. Then, ingest a separate "barrel files" document. A query for "how were barrel files used?" must return a timeline that shows the "barrel files" moment correctly parented to the "tree-shaking" moment.

---

### Iteration 3: The Truth Seeker

*   **Goal:** Add the highest-confidence correlation signal: **explicit, programmatic links**. This makes the graph more accurate and less reliant on fuzzy semantic similarity.
*   **Correlation Strategy:** Implement **Layer 1 (Explicit Links)**, making it the highest-priority signal in the correlation cascade.
*   **Tasks:**
    1.  **Upgrade Plugin API:** The `extractMomentsFromDocument` hook will be updated so it can optionally return `correlationHints` (e.g., a structured reference to another moment) alongside each `MomentDescription`.
    2.  **Implement Full Correlation Cascade:** The `indexDocument` logic will be finalized:
        1.  **First,** check for `correlationHints`. If a hint exists, resolve it to a specific parent `Moment` ID and link it directly.
        2.  **If no hints are found,** fall back to the **semantic search** from Step 2.
        3.  **If no semantic match is found,** create a new root moment.
*   **Validation:** Ingest a Cursor conversation. Then, ingest another conversation that references the first. Verify that the second conversation's moments are correctly and directly parented to the first conversation's moments.

---

### Iteration 4: GitHub Plugin

*   **Goal:** Extend moment extraction to GitHub issues and pull requests.
*   **Tasks:**
    1.  Implement `extractMomentsFromDocument` in GitHub plugin
    2.  Extract moments from issue body and comments
    3.  Extract moments from PR body and comments
*   **Validation:** Ingest a GitHub issue with multiple comments. Verify the timeline shows: `[Issue Created] -> [Comment 1] -> [Comment 2]`.

---

### Iteration 5: Discord Plugin

*   **Goal:** Extend moment extraction to Discord channels and threads.
*   **Tasks:**
    1.  Implement `extractMomentsFromDocument` in Discord plugin
    2.  Extract moments from channel messages (chronological order)
    3.  Extract moments from thread starter and replies
*   **Validation:** Ingest a Discord thread with multiple replies. Verify the timeline shows: `[Thread Started] -> [Reply 1] -> [Reply 2]`.

---

### Iteration 6: Default Plugin

*   **Goal:** Extend moment extraction to generic documents via default plugin.
*   **Tasks:**
    1.  Implement `extractMomentsFromDocument` in Default plugin
    2.  Extract a single moment from document content (fallback behavior)
*   **Validation:** Ingest a generic document. Verify a single moment is created.

---

## 3. Future Considerations (Deferred to "The Car")

*   **Sibling `Moment`s:** The current model assumes a linear chain. We will later explore modeling parallel events (e.g., multiple failed attempts) as sibling `Moment`s under a common parent.
*   **LLM as a Judge:** The most expensive correlation layer, using an LLM to determine if a new moment belongs to an existing subject, is deferred.
*   **Drill-Down Functionality:** The ability to retrieve full, verbatim content for moments will be implemented in a future iteration. This will link moments to their corresponding chunks in the Evidence Locker (via `momentId` in `ChunkMetadata`) to handle detailed follow-up questions.

---

## 4. Realizations: What Should Moments Store?

During implementation, a critical architectural question arose: **What should a `Moment` store?**

### Initial Approach: Storing Full Content

The first implementation stored the full, verbatim content of each moment directly in the database. This was simple and fast for queries, but raised concerns about:
- **Data Duplication:** The same content exists in both the R2 source document and the moment graph database, creating a source-of-truth problem.
- **Scalability:** As content grows, storing full text for every moment will bloat the database and impact performance.
- **Storage Costs:** Duplicating large amounts of text increases storage requirements.

### Alternative Considered: Storing Paths/References

An alternative was considered: storing a path (e.g., JSONPath) to the content in the source document, then "rehydrating" the full content at query time by fetching from R2.

**Pros:**
- Single source of truth (R2 remains authoritative)
- Database stays lean and scalable
- Avoids data duplication

**Cons:**
- Query-time complexity: requires fetching source document and extracting content
- Latency: adds a fetch step to every timeline query
- **Redundant:** This approach tries to make the Knowledge Graph do the Evidence Locker's job

### The Correct Realization: Store Summaries

After revisiting the original architecture document (see `2025-11-26-knowledge-synthesis-engine-design.md`), the correct approach became clear:

**The Knowledge Graph and Evidence Locker serve different purposes:**

1.  **Knowledge Graph (Moment Graph):** Contains **summaries** of what happened. It's optimized for fast semantic search to find the *story* and answer "why" questions. It provides high-level narratives.

2.  **Evidence Locker (RAG Index):** Contains **verbatim chunks** of the original content. It's optimized for filtered, high-fidelity retrieval to find the *exact details* and answer "what" questions.

**Query Flow:**
- **First Question:** "How did we solve the tree-shaking problem?" → The system searches the Knowledge Graph (summaries) to find the relevant moments and constructs a high-level narrative timeline. This answers the "why" and "how" at a conceptual level.
- **Follow-Up Question:** "What was the exact error message?" → The system queries the Evidence Locker (verbatim chunks) filtered by the relevant `momentId` to retrieve the precise details.

**Key Insight:** We should NOT try to retrieve full content from R2 at query time. That's what the Evidence Locker is for. The Knowledge Graph's job is to provide the synthesized story, not the raw evidence.

### Revised Plan: Summary-Based Moments

**Decision:** Each `Moment` will store a **summary** of what happened, generated by a "cheap" LLM call during indexing.

**Implementation Changes:**

1.  **Refactor `Moment` Type:**
    -   Change `content: string` to `summary: string`
    -   The summary is a concise, LLM-generated description of what happened in this moment

2.  **Update Plugin Hook:**
    -   The `extractMomentsFromDocument` hook will be responsible for generating summaries
    -   For each moment identified, the plugin will make a cheap LLM call to generate a summary
    -   The Cursor plugin will be the first implementation: for each generation, it will send the content to the cheap LLM and store the resulting summary

3.  **Update Ingestion:**
    -   The `indexDocument` function stores summary-based moments
    -   No changes to the chaining logic (sequential parent-child relationships remain the same)

4.  **Update Querying:**
    -   The `/timeline` endpoint returns moments with their summaries
    -   No "rehydration" step from R2
    -   The timeline provides the high-level narrative story

5.  **Defer Drill-Down:**
    -   The ability to retrieve full content for detailed follow-ups is deferred to a future iteration
    -   This will involve linking moments to chunks in the Evidence Locker (via `momentId` in `ChunkMetadata`)
    -   For now, the system focuses on building the summary-based Knowledge Graph

**Benefits:**
- Aligns with the original two-tiered architecture (Knowledge Graph vs Evidence Locker)
- Database stays lean and scalable
- Fast semantic search over summaries
- Clear separation of concerns: summaries for narrative, Evidence Locker for details
- No redundant content storage or retrieval logic

---

## 5. Realization: Refining Moment Segmentation for Cursor Conversations

During implementation of the Cursor plugin, it became clear that the initial heuristic—one moment per user/assistant exchange—was too fine-grained and would produce a noisy, unhelpful timeline. A single logical "moment" (e.g., "Attempting to fix a bug") might span several back-and-forth exchanges.

### The Problem with One-to-One Mapping

-   **Low Signal-to-Noise:** The timeline would be cluttered with minor conversational turns.
-   **Misses the Narrative Arc:** It fails to group related exchanges into a single, coherent event.
-   **Useless for the User:** A timeline of every single prompt and response is not a useful summary of a development journey.

### A More Sophisticated Approach: Semantic Grouping

To create more meaningful moments, a more intelligent segmentation strategy is required. The key insight is to use the *summary* of each exchange as a proxy for its semantic content, and then group consecutive exchanges that are semantically similar.

**Revised Implementation Plan for Cursor Plugin:**

1.  **First Pass: Summarize Each Exchange:**
    *   Iterate through the conversation and generate a concise summary for each individual user/assistant exchange using a cheap LLM.

2.  **Second Pass: Embed the Summaries:**
    *   Generate a vector embedding for each of the summaries. This converts the semantic meaning of each summary into a numerical representation.

3.  **Third Pass: Group by Similarity:**
    *   Iterate through the exchanges and calculate the cosine similarity between the summary embedding of one turn and the next.
    *   If the similarity is above a certain threshold (e.g., > 0.9), the exchanges are considered part of the same ongoing moment.
    *   A significant drop in similarity indicates a topic shift and thus a "breakpoint" for a new moment.

4.  **Final Pass: Consolidate Moments:**
    *   Merge the raw content of all exchanges within a group into a single block. This consolidated text becomes the `content` for a single, high-level `MomentDescription`.
    - The title for this consolidated moment can be generated by summarizing the combined content.

This hybrid approach leverages the efficiency of embeddings for segmentation and the nuance of LLMs for summarization, resulting in a much more meaningful and useful timeline.

---

## 6. Realization: Making Moments Queryable

After implementing the ingestion pipeline for moments, it became clear that while we are *storing* summaries, the main query engine is not *using* them. The current query path is still wired to the old "Evidence Locker" (RAG) system, which searches over raw content chunks.

This means we cannot answer narrative questions like "why was treeshaking broken, and how was it fixed?", because that requires understanding the story and causal chain of events, which is exactly what the moment summaries are designed to provide.

To make the "Bicycle" iteration functional and valuable, we must implement a query path that leverages the Moment Graph.

---

## 7. Revised Implementation Plan

### Iteration 1: The Narrative Query (Cursor Only) - REVISED

*   **Goal:** Establish a fully functional, end-to-end `Moment Graph` for a single data source (Cursor). This includes ingesting moments using semantic grouping and implementing a query path that can answer narrative, "why/how" questions by leveraging the graph's summaries.
*   **Tasks:**
    1.  **Define Core Types:** (Completed)
    2.  **Create `momentDb` Module:** (Completed)
    3.  **Update Plugin API:** (Completed)
    4.  **Implement Cursor Plugin (Semantic Grouping):** (Completed)
    5.  **Implement Simplified Ingestion:** (Completed)
    6.  **Enhance `momentDb` for Search:**
        *   Add a vector index to the `MomentGraphDO` for storing moment summary embeddings.
        *   Implement `addMoment` logic to store the summary's embedding alongside the moment data.
        *   Expose a `findSimilarMoments(vector)` function in the `momentDb` module to search the moment index.
    7.  **Implement Narrative Query Path:**
        *   In the main `query` function in `engine.ts`, create a new query path that runs *before* the existing chunk-based RAG.
        *   This path will:
            1.  Vectorize the user's query.
            2.  Call `findSimilarMoments` to find the most relevant moment in the graph.
            3.  If a moment is found, traverse the graph using `findAncestors` to reconstruct the narrative timeline.
            4.  Use the collected `summaries` from the timeline as context for an LLM prompt.
            5.  Generate a narrative answer based on the timeline.
    8.  **Integrate Query Paths:** For this iteration, if the Narrative Query Path produces an answer, we will return it. If no relevant moments are found, we can fall back to the existing chunk-based RAG system.
*   **Validation:** Ingest a single Cursor conversation about a development task (e.g., fixing a bug). Ask a narrative question like "Why was the feature broken and how was it fixed?". The system must return a coherent, narrative answer based on the timeline of moment summaries.

### Iteration 2: The Smart Linker (Cross-Document)

*   **Goal:** Introduce intelligent, **cross-document linking** during ingestion.
*   **Tasks:**
    1.  **Upgrade Ingestion Logic:** The `indexDocument` function will be enhanced. When a new moment is processed, it will now call the `findSimilarMoments` function (created in Iteration 1) to search for a parent across the *entire existing graph*. If a suitable parent is found, it will link to it; otherwise, it will create a new root moment.
*   **Validation:** Ingest a "tree-shaking" document, creating a root moment. Then, ingest a separate "barrel files" document. The ingestion process must automatically link the "barrel files" moment to the "treeshaking" moment. A query for "how were barrel files used?" must return a single, continuous timeline.

---

## 8. Strategic Pivot: Redefining the Bicycle Iteration

**Decision:** The "Narrative Query" features developed in the revised Iteration 1 have become the primary goal of the entire "Bicycle" iteration.

The "Bicycle" iteration is now defined as: **Building a complete, end-to-end Narrative Query Engine for a single data source (Cursor).**

The features originally planned for Iteration 2 (Cross-Document Linking) and subsequent plugin iterations (GitHub, Discord) are formally **deferred** to future iterations ("Car"). This allows us to ship a fully functional, high-value feature now without scope creep.

### Final Status of the Bicycle Iteration

All tasks required for this redefined scope are now **COMPLETE**:

1.  **Core Architecture:** `Moment`, `Subject`, and `MomentGraphDO` are implemented.
2.  **Ingestion Pipeline:** The system ingests Cursor conversations, uses semantic grouping to identify meaningful moments, summarizes them, and embeds the summaries.
3.  **Storage:** Moments are stored in SQLite (for structure) and Vectorize (for semantic search).
4.  **Query Engine:** A new Narrative Query path vectorizes user questions, finds relevant moments, rebuilds the timeline, and generates narrative answers using the moment summaries.

### Next Steps (Future Iterations)

*   **The Smart Linker:** Implementing cross-document linking during ingestion.
*   **The Truth Seeker:** Using explicit signals (links, references) to connect moments.
*   **Data Source Expansion:** Adding GitHub and Discord support.

---

## 9. Realization: Caching Exchange Summaries and Embeddings

During implementation, it became clear that the current approach would re-calculate summaries and embeddings for every exchange on every indexing run, even if the conversation hadn't changed. This is wasteful and expensive.

### The Problem

Every time a Cursor conversation is indexed (even if it hasn't changed), we:
1. Generate a summary for each exchange using an LLM call
2. Generate an embedding for each summary
3. Process all exchanges to group them into moments

For a conversation with 50 exchanges, that's 50 LLM calls and 50 embedding generations on every single indexing run, even if nothing changed.

### The Solution: Hybrid Caching with Structure Hash

A two-tier caching strategy:

1.  **Structure Hash (Fast Path):**
    *   After processing a conversation, compute a hash of all `generation.id`s in order (e.g., `"gen-A:gen-B:gen-C"`).
    *   Store this hash keyed by `document.id`.
    *   On the next indexing run, compute the hash again and compare.
    *   **If hashes match:** The conversation structure is unchanged. Skip all processing immediately.

2.  **Per-Generation Cache (Robust Path):**
    *   When the structure hash doesn't match (conversation changed), fall back to per-generation caching.
    *   Store `{ generationId, summary, embedding }` tuples in a cache table.
    *   For each generation in the conversation:
        *   Check if it exists in the cache.
        *   **If cached:** Use the cached summary and embedding.
        *   **If not cached:** Generate them and add to cache.
    *   This handles edits, reverts, and deletions correctly—we only regenerate what's actually new or changed.

### Implementation Plan

1.  **Add `exchange_cache` table** to `CursorEventsDurableObject` migrations (cursor-specific):
    *   `generation_id TEXT PRIMARY KEY`
    *   `summary TEXT`
    *   `embedding TEXT` (JSON array)
    *   `created_at TEXT`

2.  **Add `document_structure_hash` table** to `MomentGraphDO` migrations (document-level, could be reused for other sources):
    *   `document_id TEXT PRIMARY KEY`
    *   `structure_hash TEXT`
    *   `updated_at TEXT`

3.  **Create cursor-specific DB module** (`src/app/engine/cursorDb/index.ts`):
    *   `getExchangeCache(generationIds: string[]): Promise<Map<string, { summary: string; embedding: number[] }>>`
    *   `setExchangeCache(entries: Array<{ generationId: string; summary: string; embedding: number[] }>): Promise<void>`

4.  **Add structure hash functions** to `momentDb/index.ts`:
    *   `getDocumentStructureHash(documentId: string): Promise<string | null>`
    *   `setDocumentStructureHash(documentId: string, hash: string): Promise<void>`

5.  **Update `cursor.ts` plugin:**
    *   Compute structure hash from all `generation.id`s.
    *   Check against stored hash—if match, return early.
    *   If no match, bulk-fetch all cached exchanges from cursor DB.
    *   Process each generation, using cache when available.
    *   Bulk-write new cache entries to cursor DB.
    *   Update structure hash in moment DB.

This ensures we only do expensive work when necessary, while correctly handling all edge cases including history rewrites. The exchange cache is cursor-specific and lives in the cursor DB, while the structure hash is document-level and lives in the moment DB.

---

## 10. Refinement: Moving Exchange Cache to Cursor-Specific DB

After initial implementation, realized that `exchange_cache` is cursor-specific and shouldn't live in the general `MomentGraphDO`. Moved it to `CursorEventsDurableObject` instead, creating a new cursor-specific DB module (`src/app/engine/cursorDb/index.ts`) as a sibling to `momentDb` for cache operations. The `document_structure_hash` remains in `MomentGraphDO` since it's document-level and could potentially be reused for other data sources.

During implementation, it became clear that the current approach would re-calculate summaries and embeddings for every exchange on every indexing run, even if the conversation hadn't changed. This is wasteful and expensive.

### The Problem

Every time a Cursor conversation is indexed (even if it hasn't changed), we:
1. Generate a summary for each exchange using an LLM call
2. Generate an embedding for each summary
3. Process all exchanges to group them into moments

For a conversation with 50 exchanges, that's 50 LLM calls and 50 embedding generations on every single indexing run, even if nothing changed.

### The Solution: Hybrid Caching with Structure Hash

A two-tier caching strategy:

1.  **Structure Hash (Fast Path):**
    *   After processing a conversation, compute a hash of all `generation.id`s in order (e.g., `"gen-A:gen-B:gen-C"`).
    *   Store this hash keyed by `document.id`.
    *   On the next indexing run, compute the hash again and compare.
    *   **If hashes match:** The conversation structure is unchanged. Skip all processing immediately.

2.  **Per-Generation Cache (Robust Path):**
    *   When the structure hash doesn't match (conversation changed), fall back to per-generation caching.
    *   Store `{ generationId, summary, embedding }` tuples in a cache table.
    *   For each generation in the conversation:
        *   Check if it exists in the cache.
        *   **If cached:** Use the cached summary and embedding.
        *   **If not cached:** Generate them and add to cache.
    *   This handles edits, reverts, and deletions correctly—we only regenerate what's actually new or changed.

### Implementation Plan

1.  **Add `exchange_cache` table** to `MomentGraphDO` migrations:
    *   `generation_id TEXT PRIMARY KEY`
    *   `summary TEXT`
    *   `embedding TEXT` (JSON array)
    *   `created_at TEXT`

2.  **Add `document_structure_hash` table** to `MomentGraphDO` migrations:
    *   `document_id TEXT PRIMARY KEY`
    *   `structure_hash TEXT`
    *   `updated_at TEXT`

3.  **Add cache functions** to `momentDb/index.ts`:
    *   `getExchangeCache(generationIds: string[]): Promise<Map<string, { summary: string; embedding: number[] }>>`
    *   `setExchangeCache(entries: Array<{ generationId: string; summary: string; embedding: number[] }>): Promise<void>`
    *   `getDocumentStructureHash(documentId: string): Promise<string | null>`
    *   `setDocumentStructureHash(documentId: string, hash: string): Promise<void>`

4.  **Update `cursor.ts` plugin:**
    *   Compute structure hash from all `generation.id`s.
    *   Check against stored hash—if match, return early.
    *   If no match, bulk-fetch all cached exchanges.
    *   Process each generation, using cache when available.
    *   Bulk-write new cache entries.
    *   Update structure hash.

This ensures we only do expensive work when necessary, while correctly handling all edge cases including history rewrites.

---

## 11. Refinement: Moving Exchange Cache to Cursor-Specific DB

After initial implementation, realized that `exchange_cache` is cursor-specific and shouldn't live in the general `MomentGraphDO`. Moved it to `CursorEventsDurableObject` instead, creating a new cursor-specific DB module (`src/app/engine/cursorDb/index.ts`) as a sibling to `momentDb` for cache operations. The `document_structure_hash` remains in `MomentGraphDO` since it's document-level and could potentially be reused for other data sources. The exchange cache is cursor-specific and lives in the cursor DB, while the structure hash is document-level and lives in the moment DB.
