# Work Log: Moment Graph Refactor (Bicycle Iteration)

**Date:** 2025-12-09

## 1. Goal: Refactor to a `Moment Graph`

The "Skateboard" iteration successfully implemented an end-to-end system based on a flat list of `Subject`s. The goal of this "Bicycle" iteration is to refactor the core architecture to a more expressive **`Moment Graph`**, which can capture the rich, evolving, and causal relationships between pieces of information.

A "Subject" will remain the primary conceptual entity, defined by a **root `Moment`** in the graph. All `Moment`s descending from that root collectively form the story of that Subject.

## 2. The Iterative "Bicycle" Plan

The refactoring will be executed in three distinct, end-to-end functional steps. Each step will build upon the last, culminating in a sophisticated graph-based system.

---

### Iteration 1: The Basic Chain

*   **Goal:** Establish the minimum viable `Moment Graph`. The focus is on getting the new data structures, database module, and pipeline in place, proving we can build and retrieve a simple, linear chain of moments from a **single document**.
*   **Correlation Strategy:** A simplified version of **Layer 2 (Contextual Affinity)**. We will assume all moments extracted from one document during a single indexing run are causally linked in sequence.
*   **Tasks:**
    1.  **Define Core Types:** Create the `Moment` and revised `Subject` types in `types.ts`. Update `ChunkMetadata` to use `momentId`.
    2.  **Create `momentDb` Module:**
        *   Create the `MomentGraphDO` as an internal implementation detail.
        *   Create a `momentDb` module that exports **static, functional methods** for interacting with the DO (e.g., `addMoment(db, moment, vector)`, `findAncestors(db, momentId)`). The `db` object will be created in the engine and passed to these functions.
    3.  **Update Plugin API:** In `types.ts`, replace the `determineSubjectsForDocument` hook with `subjects.extractMomentsFromDocument`.
    4.  **Implement Simplified Ingestion:** The `indexDocument` function will call the new plugin hook. For the list of moments returned from a single document, it will chain them together sequentially (the first becomes a root, the second is a child of the first, etc.).
    5.  **Implement Basic Querying:** Implement the `/timeline` endpoint. The handler will find the *last* moment associated with a document and call `findAncestors` to retrieve the full chain.
*   **Validation:** Ingest a single GitHub issue with multiple comments. A query about that issue must return a single, ordered timeline of moments: `[Issue Created] -> [Comment 1] -> [Comment 2]`.

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
    1.  **Upgrade Plugin API:** The `extractMomentsFromDocument` hook will be updated so it can optionally return `correlationHints` (e.g., a structured reference to another GitHub issue) alongside each `MomentDescription`.
    2.  **Implement Full Correlation Cascade:** The `indexDocument` logic will be finalized:
        1.  **First,** check for `correlationHints`. If a hint exists, resolve it to a specific parent `Moment` ID and link it directly.
        2.  **If no hints are found,** fall back to the **semantic search** from Step 2.
        3.  **If no semantic match is found,** create a new root moment.
*   **Validation:** Ingest a GitHub Issue. Then, ingest a Pull Request that contains the text `closes #issue_number` in its body. Verify that the PR's moment is correctly and directly parented to the Issue's moment, even if their titles are semantically dissimilar.

---

## 3. Future Considerations (Deferred to "The Car")

*   **Sibling `Moment`s:** The current model assumes a linear chain. We will later explore modeling parallel events (e.g., multiple failed attempts) as sibling `Moment`s under a common parent.
*   **LLM as a Judge:** The most expensive correlation layer, using an LLM to determine if a new moment belongs to an existing subject, is deferred.
