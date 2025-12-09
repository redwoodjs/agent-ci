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
... (previous sections remain the same) ...

---

## 5. Realization: Refining Moment Segmentation for Cursor Conversations
... (previous sections remain the same) ...

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
