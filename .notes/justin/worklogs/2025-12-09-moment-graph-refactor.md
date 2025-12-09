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

1. **Knowledge Graph (Moment Graph):** Contains **summaries** of what happened. It's optimized for fast semantic search to find the *story* and answer "why" questions. It provides high-level narratives.

2. **Evidence Locker (RAG Index):** Contains **verbatim chunks** of the original content. It's optimized for filtered, high-fidelity retrieval to find the *exact details* and answer "what" questions.

**Query Flow:**
- **First Question:** "How did we solve the tree-shaking problem?" → The system searches the Knowledge Graph (summaries) to find the relevant moments and constructs a high-level narrative timeline. This answers the "why" and "how" at a conceptual level.
- **Follow-Up Question:** "What was the exact error message?" → The system queries the Evidence Locker (verbatim chunks) filtered by the relevant `momentId` to retrieve the precise details.

**Key Insight:** We should NOT try to retrieve full content from R2 at query time. That's what the Evidence Locker is for. The Knowledge Graph's job is to provide the synthesized story, not the raw evidence.

### Revised Plan: Summary-Based Moments

**Decision:** Each `Moment` will store a **summary** of what happened, generated by a "cheap" LLM call during indexing.

**Implementation Changes:**

1. **Refactor `Moment` Type:**
   - Change `content: string` to `summary: string`
   - The summary is a concise, LLM-generated description of what happened in this moment

2. **Update Plugin Hook:**
   - The `extractMomentsFromDocument` hook will be responsible for generating summaries
   - For each moment identified, the plugin will make a cheap LLM call to generate a summary
   - The Cursor plugin will be the first implementation: for each generation, it will send the content to the cheap LLM and store the resulting summary

3. **Update Ingestion:**
   - The `indexDocument` function stores summary-based moments
   - No changes to the chaining logic (sequential parent-child relationships remain the same)

4. **Update Querying:**
   - The `/timeline` endpoint returns moments with their summaries
   - No "rehydration" step from R2
   - The timeline provides the high-level narrative story

5. **Defer Drill-Down:**
   - The ability to retrieve full content for detailed follow-ups is deferred to a future iteration
   - This will involve linking moments to chunks in the Evidence Locker (via `momentId` in `ChunkMetadata`)
   - For now, the system focuses on building the summary-based Knowledge Graph

**Benefits:**
- Aligns with the original two-tiered architecture (Knowledge Graph vs Evidence Locker)
- Database stays lean and scalable
- Fast semantic search over summaries
- Clear separation of concerns: summaries for narrative, Evidence Locker for details
- No redundant content storage or retrieval logic

---

## 5. Revised Implementation Plan

### Iteration 1: The Basic Chain (Cursor Only) - REVISED

*   **Goal:** Establish the minimum viable `Moment Graph` using **Cursor conversations** as the test subject. The focus is on getting the new data structures, database module, and pipeline in place, proving we can build and retrieve a simple, linear chain of moments from a **single document**.
*   **Correlation Strategy:** A simplified version of **Layer 2 (Contextual Affinity)**. We will assume all moments extracted from one document during a single indexing run are causally linked in sequence.
*   **Data Source:** Cursor conversations only. Other data sources (GitHub, Discord, Default) will be implemented in later iterations after we validate the concept.
*   **Tasks:**
    1.  **Define Core Types:** Create the `Moment` type with `summary` field (not `content`). Create `MomentDescription` interface for plugin hook return type.
    2.  **Create `momentDb` Module:**
        *   Create the `MomentGraphDO` as an internal implementation detail.
        *   Create a `momentDb` module that exports **static, functional methods** for interacting with the DO (e.g., `addMoment(db, moment)`, `findAncestors(db, momentId)`).
    3.  **Update Plugin API:** In `types.ts`, add `subjects.extractMomentsFromDocument` hook that returns `MomentDescription[]` with summaries.
    4.  **Implement Cursor Plugin:** The Cursor plugin will implement `extractMomentsFromDocument` to:
        *   Extract moments from each generation (user prompt + assistant response)
        *   For each moment, make a cheap LLM call to generate a summary
        *   Return moments with `title`, `summary`, `author`, `createdAt`, and `sourceMetadata`
    5.  **Implement Simplified Ingestion:** The `indexDocument` function will call the new plugin hook. For the list of moments returned from a single document, it will chain them together sequentially (the first becomes a root, the second is a child of the first, etc.).
    6.  **Implement Basic Querying:** Implement the `/timeline` endpoint. The handler will find the *last* moment associated with a document and call `findAncestors` to retrieve the full chain. Returns moments with summaries (no content rehydration).
*   **Validation:** Ingest a single Cursor conversation with multiple generations. A query about that conversation must return a single, ordered timeline of moments with summaries: `[Generation 1 Summary] -> [Generation 2 Summary] -> [Generation 3 Summary]`.
