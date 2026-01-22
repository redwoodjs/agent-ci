# Knowledge Synthesis Engine

The Knowledge Synthesis Engine is the "Brain" of Machinen. While the Evidence Locker handles *factual* retrieval ("what happened"), the Knowledge Synthesis Engine handles *narrative* retrieval ("why it happened").

It works by transforming raw, noisy event logs into a structured **Moment Graph**, allowing LLMs to reason about cause-and-effect over long timelines.

## The Core Challenge: Connecting the Dots

Software development is noisy. A single "feature" might span:
1.  A proposal issue on GitHub.
2.  A 50-message debate in a Discord thread.
3.  Three different Pull Requests.
4.  A final "merged" event.

A traditional RAG system sees these as four unrelated documents. If you ask "Why did we build X?", RAG might find the PR code, but miss the Discord debate where the decision was actually made.

To solve this, we don't just index text. We synthesize **Moments** (structured events) and link them into a **Causal Graph**.

---

## 1. The Synthesis Pipeline

The engine processes data in a strict, renewable pipeline. This pipeline is designed to be **restartable** (so we can fix logic bugs without re-ingesting data) and **core-authoritative** (so live and simulation modes behave identically).

### Step 1: Segmentation & Caching (The "Phase Core" Identity)
*Phases: `ingest_diff`, `micro_batches`*

Raw logs (chat streams, git diffs) are too noisy for an LLM. We first break documents down into **Micro-Moments**—atomic units of conversation or code change.

Crucially, we define a strict **Input Identity** here.
*   **The Problem**: If we re-run the pipeline, we shouldn't re-summarize a Discord thread if only the last message changed.
*   **The Solution**: We hash the inputs (content + prompt context). If the hash matches, we skip the expensive LLM call and reuse the cached micro-moments.
*   **Drift Prevention**: This identity logic lives in the **Phase Core**, shared by both Live and Simulation pipelines. This ensures that "what counts as a change" is mathematically identical in both modes.

### Step 2: Synthesis (The "Historian")
*Phases: `macro_synthesis`, `macro_classification`, `materialize_moments`*

We feed the stream of Micro-Moments to an LLM acting as a "Historian." Its job is to:
1.  **Filter Noise**: Ignore "LGTM"s and lunch coordination.
2.  **Synthesize**: Generate **Macro-Moments**—high-level summaries of significant events.
3.  **Classify**: Label moments (e.g., `Feature`, `Bug`, `Chore`) so we can filter the graph later.

**Materialization**:
Once synthesized, moments are "Materialized" (assigned stable IDs). This is a hard checkpoint. Even if a moment isn't linked to anything yet, it exists in the universe.

### Step 3: Graph Construction (Linking)
*Phases: `deterministic_linking`, `candidate_sets`, `timeline_fit`*

This is where the graph emerges. We use a **Progressive Refinement** strategy to link moments together from different documents.

1.  **Deterministic Linking (High Confidence)**:
    *   We look for explicit signals: a PR body saying "Fixes #123", or a canonical reference token (`mchn://...`) embedded in the summary.
    *   If we find a match, we link immediately. It's fast, cheap, and 100% accurate.

2.  **Candidate Generation (Recall)**:
    *   For moments that remain unlinked, we use vector search (embeddings) to find a "Shortlist" of potential parents.
    *   We apply strict **Invariants** here:
        *   *Time Traveling*: A child cannot be older than its parent.
        *   *Namespace Isolation*: Test data cannot link to Production data.

3.  **Timeline Fit (Precision)**:
    *   The expensive step. We verify the candidates.
    *   For complex cases, we ask an LLM: "Given the timeline of Issue X, does this Pull Request logically belong to it?"
    *   This separates "finding" (Recall) from "deciding" (Precision).

---

## 2. Architecture: "Phase Cores" and Adapters

To ensure that our Simulation (Backfill) runs are accurate predictors of Live behavior, we strictly separate **Business Logic** from **Runtime Wiring**.

### The Phase Core (The "Brain")
Each phase has a `core` module. This module is:
*   **Pure**: It takes inputs and computes outputs/decisions.
*   **Stateless**: It doesn't know about databases, queues, or R2.
*   **Authoritative**: It defines the "Identity" of work and the "Rules" of liking.

### The Adapters (The "Hands")
We wrap the Core in two different adapters:

1.  **Simulation Adapter (Batch)**:
    *   Reads from R2/Durable Objects.
    *   Persists *everything* (full artifacts, decision logs) so we can debug "why did the linker reject this candidate?".
    *   Optimized for Restartability.

2.  **Live Adapter (Stream)**:
    *   Reads from Event Queues.
    *   Persists *only the result* (writes the link to the DB).
    *   Optimized for Latency.

By sharing the Core, we guarantee that logic drift is impossible. A change to the "Timeline Fit" prompt impacts backfills and live events simultaneously.

---

## 3. Querying: The Narrative Waterfall

When a user asks "Why?", we reverse the process.

1.  **Anchor Search**: We find the moments in the graph that match the query.
2.  **Root Resolution**: We walk up the graph to find the "Subject" (the root problem or feature).
3.  **Timeline Retrieval**: We fetch the *entire* history of that Subject—including all linked PRs, later Discord discussions, and regression fixes.
4.  **Narrative Generation**: We give the LLM this full, coherent timeline. It answers the user's question with the full context of the "journey," not just the isolated search results.
