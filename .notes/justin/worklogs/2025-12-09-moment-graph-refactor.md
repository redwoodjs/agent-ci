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

---

## 12. Realization: Re-Centering Subjects as Primary Query Entry Point

During implementation, realized that we had lost sight of the original concept: **Subjects are the primary entry point for understanding narratives**. The current query implementation searches moments directly, but this misses the higher-level organization.

### The Problem

The current narrative query path:
1. Searches `MOMENT_INDEX` for any moment matching the query
2. Uses `findAncestors` to build a timeline backwards from that moment
3. This treats all moments equally, missing the concept that **root moments represent Subjects**

This means we're querying at the detail level (moments) rather than the topic level (subjects). The moments are the details, but the subject is the main topic.

### The Solution: Subject-First Query Architecture

Re-center the query architecture around Subjects:

1.  **Index Root Moments as Subjects:**
    *   When a moment is created with no `parentId` (a root moment), it represents a Subject.
    *   Index root moments in `SUBJECT_INDEX` (in addition to `MOMENT_INDEX`).
    *   This promotes root moments to queryable "Subjects."

2.  **Query Subjects First:**
    *   Change the narrative query path to search `SUBJECT_INDEX` first.
    *   Find the most relevant Subject (root moment) that matches the user's question.

3.  **Retrieve Full Narrative Timeline:**
    *   Once the Subject is identified, retrieve all its **descendant moments** (forward from root).
    *   Add a `findDescendants` function that traverses the parent-child relationships forward.

4.  **Synthesize Answer:**
    *   With the full Subject timeline (root moment + all descendants), the LLM can synthesize a comprehensive answer.
    *   This creates a two-step process: find the right Subject (chapter), then read the full chapter (all moments).

### Implementation

1.  **Updated `momentDb/index.ts` `addMoment` function:**
    *   Checks if `moment.parentId` is null/undefined (root moment).
    *   If root moment, also inserts into `SUBJECT_INDEX` with the same embedding and metadata.

2.  **Added `findDescendants` function to `momentDb/index.ts`:**
    *   Takes a root moment ID.
    *   Recursively finds all moments that have this moment as an ancestor.
    *   Returns moments in chronological order (root first, then descendants).

3.  **Added `findSimilarSubjects` function to `momentDb/index.ts`:**
    *   Queries `SUBJECT_INDEX` with a query vector.
    *   Returns the most relevant Subjects (root moments).

4.  **Updated `engine.ts` query function:**
    *   Changed narrative query path to search `SUBJECT_INDEX` instead of `MOMENT_INDEX`.
    *   Uses `findDescendants` instead of `findAncestors` to get the full timeline forward from the Subject.
    *   Updated the prompt to reflect that we're answering based on a Subject and its timeline.

This ensures Subjects are the primary entry point, with moments providing the detailed narrative context.

---

## 13. Refinement: Adjusting Similarity Threshold for Finer-Grained Moment Segmentation

After testing with a 93-exchange conversation, the initial `SIMILARITY_THRESHOLD` of `0.9` produced 91 moments (almost one per exchange), which is too granular. The goal is to group exchanges into meaningful moments, aiming for roughly 10-20 moments for a conversation of this size.

**Analysis:**
- With threshold `0.9`, most exchanges were below the threshold (similarities in the 0.6-0.8 range)
- Only one instance observed where two exchanges were grouped (similarity `0.901`)
- This indicates the threshold was too high, preventing meaningful grouping

**Solution:**
Lowered `SIMILARITY_THRESHOLD` from `0.9` to `0.7` in `src/app/engine/plugins/cursor.ts`. This should allow exchanges with moderate semantic similarity (0.7-0.9 range) to be grouped together, creating fewer, more meaningful moments that better capture the narrative arc of the conversation.

The threshold can be further adjusted based on testing results to achieve the desired granularity.

---

## 14. Debugging: 'too many SQL variables' Error

During testing with a large conversation (105 generations), an error `too many SQL variables` was encountered. This occurred in the `getExchangeCache` function, which was attempting to fetch all cached exchanges using a `WHERE IN` clause with a large number of `generationId`s.

### Solution: JSON Blob for Exchange Cache

To resolve this, the exchange caching mechanism was refactored to avoid bulk `WHERE IN` clauses, a pattern that has proven problematic in the past.

1.  **Schema Change:**
    *   The `exchange_cache` table was migrated. Instead of one row per `generation_id`, it now has one row per `document_id`.
    *   All cached data for a document (summaries and embeddings for all its exchanges) is stored in a single `cache_json` TEXT column.

2.  **Function Updates:**
    *   `getExchangeCache(documentId)` now fetches the single row for the document and parses the JSON blob.
    *   `setExchangeCache(documentId, entries)` now fetches the existing JSON blob, merges the new entries into the JSON object in memory, and writes the entire updated blob back to the database in a single `UPSERT` operation.

This approach resolves the "too many variables" error by ensuring database lookups and writes operate on a single row per document, effectively moving the complexity of handling many exchanges from the SQL query to the application layer.

---

## 15. Refinement: Improving Moment Granularity and Title Framing

After a successful test run with `SIMILARITY_THRESHOLD = 0.7` yielded 48 moments from 103 exchanges, further refinements were identified to improve the quality of the narrative graph.

### The Problem

1.  **Titles are Topics, Not Events:** The LLM-generated titles for moments describe topics (e.g., "SQLite Limitations for Graph Database Queries") rather than events that happened (e.g., "Limitations of SQLite for graph queries were identified"). This makes the timeline feel less like a narrative of events.
2.  **Granularity is Still Too High:** 48 moments is still too fine-grained. The goal is to identify more significant "milestones" or "turning points" in the conversation, rather than capturing every minor shift. Many single-exchange moments are still being created, which adds noise.

### The Solution: Prompt Engineering and Threshold Adjustment

1.  **Reframe Titles with a New Prompt:**
    *   The prompt used to generate the title for a consolidated moment will be updated.
    *   It will explicitly instruct the LLM to frame the title as a past-tense event that describes what happened during that moment.

2.  **Lower Similarity Threshold to Find Turning Points:**
    *   To create fewer, more meaningful moments, the `SIMILARITY_THRESHOLD` will be lowered further, from `0.6` to `0.6`.
    *   This will allow the conversation to drift more before a new moment (a "turning point") is created, forcing more exchanges to be grouped together and reducing the number of single-exchange moments.

These two changes aim to produce a more coherent, less noisy, and more narratively compelling Moment Graph.

---

## 16. Strategic Pivot: Two-Phase Segmentation and Synthesis

After testing the similarity-threshold approach, it became clear that trying to get granularity perfect with a single numerical threshold is brittle and doesn't capture the narrative complexity of conversations. A more robust approach is needed.

### The Problem with Threshold-Based Segmentation

The current approach uses cosine similarity between exchange embeddings to group exchanges into moments. However:
- **Brittle:** A single threshold value cannot capture the nuanced narrative structure of different conversations
- **Limited Context:** Similarity-based grouping doesn't understand which exchanges actually matter for the narrative
- **Noise:** Many single-exchange moments are still created, adding noise to the timeline
- **Shallow Summaries:** The summaries generated are brief and don't capture the "why" and "how" of what happened

### The Solution: Two-Phase Approach

A two-phase process that separates segmentation from synthesis:

**Phase 1: Segmentation (Micro-Moments)**
- Extract all exchanges from the conversation
- Summarize and embed each exchange (using existing caching)
- Create "micro-moments" - one per exchange, or use a very generous similarity threshold
- This phase is about collecting raw data without worrying about noise

**Phase 2: Synthesis (Macro-Moments)**
- Pass all micro-moments to a more powerful LLM
- The LLM acts as a historian, analyzing the raw data to:
  - Identify which micro-moments actually matter for the narrative
  - Consolidate related micro-moments into higher-level "macro-moments"
  - Generate richer summaries that explain the "why" and "how" of what happened
- Return consolidated macro-moments with detailed, narrative-focused summaries

### Benefits

- **Higher Quality Narrative:** The final timeline focuses on what actually matters
- **Richer Context:** Summaries can be much more detailed and useful
- **More Robust:** Less dependent on tweaking a single similarity number
- **Better Understanding:** LLM can reason about narrative structure, not just semantic similarity

### Tradeoffs

- **Cost:** Additional LLM call during indexing (but higher quality output)
- **Latency:** Slightly longer indexing time (but better query results)

### Implementation Plan

1. **Modify Cursor Plugin:**
   - Phase 1: Create micro-moments (one per exchange, or very low threshold like 0.3)
   - Phase 2: Add synthesis function that passes all micro-moments to LLM
   - LLM prompt should instruct it to identify important moments and consolidate related ones
   - LLM should generate richer summaries with why/how context

2. **Synthesis Function:**
   - Takes array of micro-moments as input
   - Formats them for LLM consumption
   - Calls LLM with structured prompt
   - Parses LLM response to extract consolidated macro-moments
   - Returns array of `MomentDescription` objects

This approach leverages LLM reasoning for narrative understanding rather than relying solely on numerical similarity thresholds.

---

## 17. Architectural Refinement: Formalizing Micro-Moments and the Synthesis Pipeline

The two-phase "segmentation and synthesis" model is a significant improvement, but its current implementation inside the Cursor plugin is a temporary workaround. A more robust, system-wide architectural change is needed to formalize this pattern.

### The Problem with the Plugin-Specific Approach

1.  **Logic is Siloed:** The powerful synthesis logic is confined to the Cursor plugin and cannot be reused by other data sources like GitHub or Discord.
2.  **Apples and Oranges:** The `moments` table currently stores high-level narrative moments, but the process to create them relies on passing around `MomentDescription` objects that are actually just granular exchanges. This mixes two different levels of abstraction.
3.  **Data Handling is a Hack:** The `---SYNTHESIZED_SUMMARY---` marker is a brittle workaround to the problem of needing to pass both raw content and a synthesized summary through a pipeline that only expects one content field.

### The Solution: A Core Synthesis Pipeline

The concept of "micro-moments" (the raw data) and "moments" (the synthesized narrative) will be formalized as first-class citizens in the engine's architecture.

**1. New `micro_moments` Table:**
*   A dedicated table will be created to store the raw, granular events extracted from source documents.
*   This table will hold the content of individual exchanges, commits, comments, etc. It is the persistent, raw input for the synthesis process.

**2. `moments` Table Becomes `macro_moments`:**
*   The existing `moments` table will now exclusively store the high-level, synthesized "macro-moments" that are the output of the synthesis process. These are the moments that form the queryable narrative timeline.

**3. Core Synthesis Pipeline in the Engine:**
*   The synthesis logic will be extracted from the Cursor plugin and moved into the core `engine.ts`.

**Revised Ingestion Flow:**

1.  **Plugin Hook Renamed:** The plugin hook `extractMomentsFromDocument` will be renamed to `extractMicroMomentsFromDocument`. Its job is only to extract the raw, granular events from a source document. Each micro-moment includes a `path` field (source-specific identifier like generation ID, comment ID, message ID).
2.  **Cache Check & Store Micro-Moments:** For each micro-moment returned by the plugin:
    *   Engine checks if `(document_id, path)` already exists in `micro_moments` table.
    *   **If exists:** Use cached `summary` and `embedding` from the existing micro-moment.
    *   **If not exists:** Generate `summary` and `embedding`, then insert new micro-moment into table.
3.  **Core Synthesis Step:** The engine then triggers a new, core `synthesizeMoments` function. This function:
    *   Retrieves all micro-moments for the document from the database (using cached summaries/embeddings when available).
    *   Runs them through the LLM-based consolidation and summarization process.
4.  **Store Macro-Moments:** The resulting high-level "macro-moments" are stored in the main `moments` table, linked to their subject, and ready for querying.

### Benefits of this Architecture

*   **Clear Separation of Concerns:** A clean division between raw data (`micro_moments`) and the synthesized narrative (`moments`).
*   **Reusable & Extensible:** The synthesis pipeline is now a core engine feature that any plugin can use simply by providing micro-moments.
*   **Robust & Scalable:** A proper database schema is far more reliable than string markers and temporary in-memory objects.
*   **Improved Traceability:** A synthesized macro-moment can be traced back to the exact set of micro-moments that were used to create it, improving debugging and transparency.

### Unified Caching Strategy: Micro-Moments as Cache

The `micro_moments` table will serve a dual purpose: it is both the raw data for synthesis AND the cache for expensive operations (summary generation, embedding).

**The Problem with Source-Specific Caches:**

Currently, the Cursor plugin maintains a separate `exchange_cache` table in `CursorEventsDurableObject` to avoid regenerating summaries and embeddings for unchanged exchanges. This pattern would need to be replicated for every data source (GitHub comments cache, Discord message cache, etc.), creating maintenance overhead and inconsistency.

**The Solution: Micro-Moments as Universal Cache:**

The `micro_moments` table will include a `path` field that serves as a source-specific identifier within a document:
*   **Cursor:** `path` = `generation.id` (e.g., `"gen-abc123"`)
*   **GitHub:** `path` = `comment.id` or `issue.id` (e.g., `"comment-456"`)
*   **Discord:** `path` = `message.id` (e.g., `"msg-789"`)

The composite key `(document_id, path)` uniquely identifies each micro-moment.

**How Caching Works:**

1.  **Plugin extracts micro-moments:** The `extractMicroMomentsFromDocument` hook returns `MicroMomentDescription[]`, where each includes:
    *   `path`: The source-specific identifier (generation ID, comment ID, etc.)
    *   `content`: The raw content
    *   `author`, `createdAt`, `sourceMetadata`: Metadata

2.  **Engine checks for existing micro-moments:** For each micro-moment returned by the plugin, the engine queries `micro_moments` table for `(document_id, path)`.

3.  **Cache hit:** If a micro-moment exists with matching `(document_id, path)`, use its cached `summary` and `embedding`. Skip expensive LLM/embedding calls.

4.  **Cache miss:** If no micro-moment exists, generate `summary` and `embedding`, then insert the new micro-moment into the table.

5.  **Structure hash optimization:** The `document_structure_hash` check remains as a fast-path optimization. If the document structure is unchanged (same paths in same order), skip all processing entirely.

**Plugin API Changes:**

The `extractMicroMomentsFromDocument` hook signature will be updated to return `MicroMomentDescription[]`:

```typescript
interface MicroMomentDescription {
  path: string;  // Source-specific identifier (generation ID, comment ID, etc.)
  content: string;
  author: string;
  createdAt: string;
  sourceMetadata?: Record<string, any>;
}
```

**Benefits:**

*   **Eliminates source-specific caches:** No need for `exchange_cache`, `comment_cache`, `message_cache`, etc.
*   **Unified caching strategy:** All data sources use the same caching mechanism via `micro_moments`.
*   **Natural cache invalidation:** If a document is re-indexed and a `path` no longer exists in the source, the corresponding micro-moment becomes orphaned but doesn't cause issues (it's simply not used in the new synthesis).
*   **Handles edits gracefully:** If content at a `path` changes, the plugin will return new content. The engine detects the change (content hash mismatch) and regenerates summary/embedding, updating the micro-moment.
*   **Simpler plugin implementation:** Plugins only need to extract raw micro-moments with paths. The engine handles all caching, summarization, and embedding logic.

---

## 18. Path to PR and Next Steps

We have successfully implemented the "Narrative Query Engine" (Bicycle Iteration 1 Revised). The system now:
1.  Ingests Cursor conversations as "micro-moments".
2.  Synthesizes them into high-level "macro-moments" using an LLM.
3.  Indexes root macro-moments as "Subjects".
4.  Answers queries by finding the relevant Subject and reconstructing its full narrative timeline.

To prepare for a clean PR, we need to finalize the code and document the deferred work.

### PR Readiness Tasks

1.  **Remove Verbose Logging:** The current implementation contains extensive `console.log` statements for debugging the synthesis and query paths. These must be removed from:
    *   `src/app/engine/engine.ts`
    *   `src/app/engine/momentDb/index.ts`
    *   `src/app/engine/plugins/cursor.ts`
2.  **Verify Code Cleanliness:** Ensure no commented-out code or temporary debugging artifacts remain.
3.  **Final Review:** Verify consistent variable naming and type usage.
4.  **Revise architecture documents** for architecture changing, adding new sections where appropriate
5.  **Append a title and PR description** to the worklog

### Loose Ends / Future Work ("The Car")

The following features were part of the original broad "Bicycle" plan but have been deferred to the next iteration ("The Car") to maintain a focused scope:

1.  **The Smart Linker:** Cross-document linking via semantic search (`findSimilarMoments`) during ingestion. Currently, we only link moments within a single document.
2.  **The Truth Seeker:** Explicit linking using `correlationHints` from plugins.
3.  **Data Source Expansion:** Adding GitHub and Discord plugins.
4.  **Drill-Down Functionality:** Linking moments to specific evidence chunks to allow users to "double-click" on a moment and see the raw data.

---

## 19. PR Description

**Title:** `feat: Narrative Query Engine (Moment Graph Architecture)`

### The Idea: Mimicking Human Memory
Current RAG systems struggle to connect the dots between seemingly unrelated events. For example, an AI seeing "tree-shaking broken" and "barrel files implemented" might not understand the causal link between them without explicit context.

This PR introduces the **Knowledge Synthesis Engine**, a new architecture designed to mimic how human memory works. Instead of storing a flat list of text chunks, we build a **Moment Graph**:
*   **Moments:** Discrete, significant events (turning points, decisions, discoveries).
*   **Subjects:** The "root" moment that defines a stream of work or topic.
*   **The Graph:** A linked structure where moments are connected chronologically and causally.

When a query comes in (e.g., "Why did we switch to barrel files?"), the engine doesn't just keyword-match chunks. It finds the relevant **Subject** and reconstructs the full **Timeline** of moments—from the initial problem to the final solution—to tell the complete story.

### The Changes
*   **Moment Graph Architecture:** Introduced `Moment` and `Subject` core types and the `MomentGraphDO` (Durable Object) to persist the graph structure (SQLite) and semantic indexes (Vectorize).
*   **Two-Phase Ingestion Pipeline:**
    *   **Extraction (Micro-Moments):** Plugins now extract raw, granular "Micro-Moments" (e.g., individual chat exchanges).
    *   **Synthesis (Macro-Moments):** A core engine process uses an LLM as a "Historian" to analyze the stream of micro-moments, identifying key turning points and synthesizing them into high-level "Macro-Moments" with rich summaries.
*   **Subject-First Querying:** Implemented a new **Narrative Query Path** that prioritizes finding a Subject and reading its timeline over traditional chunk-based retrieval.
*   **Unified Caching:** `Micro-Moments` act as a universal cache key `(documentId, path)`, preventing expensive re-processing of unchanged source events.
*   **Cursor Plugin:** Updated to support the new `extractMicroMomentsFromDocument` hook.

### What's Next (Micro-Iterations)
*   **The Smart Linker:** Implementing cross-document linking (Layer 3 Correlation) to connect moments across different files (e.g., linking a PR to the Issue it solves).
*   **The Truth Seeker:** Using explicit signals (Layer 1 Correlation) like programmatic links for high-confidence graph connections.
*   **Drill-Down:** Connecting high-level Moments back to their raw Evidence Chunks for detailed inspection.
*   **Data Sources:** Expanding the Moment Graph to GitHub and Discord.
