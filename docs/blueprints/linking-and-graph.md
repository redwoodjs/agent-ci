# Linking and Graph Blueprint

**Status**: Living Document
**Last Updated**: 2026-01-26

## 1. Purpose

The Linking subsystem takes a collection of isolated Moments and stitches them into a **Causal Graph**. It answers: "What led to what?"

## 2. Progressive Refinement Strategy

We link in layers, starting with the cheapest/most-certain linkers and moving to the most expensive/probabilistic ones.

### Layer 1: Deterministic Linking (High Confidence)
*   **Method**: Explicit Signals.
    *   "Fixed in #123" -> Link to Issue 123.
    *   "Part of PR #456" -> Link to PR 456.
*   **Cost**: Near Zero (Regex/String matching).
*   **Precision**: 100%.

### Layer 2: Candidate Generation (Recall)
*   **Method**: Vector Search (Embeddings).
*   **Goal**: Find potential parents that *might* be related, even if not explicitly named.
*   **Output**: A bounded "Candidate Set" (e.g., top 10 matches).
*   **Constraint**: Use the **Time Invariant** filter here (exclude parents younger than children).

### Layer 3: Timeline Fit (Precision)
*   **Method**: LLM / Logic Judge.
*   **Goal**: Select the *single best* parent from the candidate set (or reject all).
*   **Context**: The Judge sees the "Timeline" of the candidate (its past and future) to see if the child fits the narrative gap.

## 3. The Graph Model

*   **Nodes**: Moments.
*   **Edges**: `ParentLink` (Child -> Parent).
*   **DAG**: The graph is a Directed Acyclic Graph (mostly). Cycles are forbidden.

## 4. Invariants

*   **Time Travel**: A Child Moment usually cannot occur before its Parent. (Exception: Planning meetings might precede the work, but causality usually flows forward in time).
*   **Namespace Scoping**: A Moment in the `redwood` namespace cannot link to a parent in the `test` namespace.
*   **Single Parent (Loose)**: We generally prefer a single primary parent for narrative clarity, though the data model allows multiple.
*   **Audit Trail**: Every link must explain *why* it exists. The **Core logic** (not the Runner) must produce this explanation.
    *   `Deterministic`: "Matched rule `fixes-keyword` in body."
    *   `TimelineFit`: "LLM confidence 0.95: Logical follow-up to discussion."
