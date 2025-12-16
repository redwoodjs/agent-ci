# Demo Readiness Todos (Next Few Days)

## Context
We’ve got a demo coming up soon, and the core pipeline (ingest → index → smart-link → query) is now working well enough to produce a coherent narrative timeline on production.

The goal for the next few days is **polish + reliability**:
- Make the MCP UX smoother (Cursor tools show up quickly + reliably).
- Remove a couple sharp edges in ingestion/indexing so we can confidently populate and query demo data.
- Create an isolated demo namespace on prod so we can iterate without contaminating “real” prod narratives.

## Current baseline (working)
- **Cross-source smart linking is working** (issue ↔ PR ↔ discord ↔ cursor), and `/query` can retrieve a coherent timeline from any entry point.
- We can **populate demo data via `/admin/resync` inline** for specific `r2Key`s (reliable and deterministic).

## Todos

### 1) Fix Cursor MCP server to show up more readily
- **Why**: Demo flow relies on “open Cursor → tools are there → query immediately”.
- **What**:
  - Make it require less “nudging” to get Cursor to actually use it.
  - Add an explicit “I’m talking to you / use Machinen MCP now” directive pattern (prompting / instruction text) so Cursor reliably routes queries to Machinen when appropriate.
  - Fix current breakage: MCP tool calls are erroring (likely an args/schema mismatch like `"query" not expected` or `"query" required but missing`).
- **Done when**:
  - From a clean start, Cursor shows the MCP server + tools consistently within a few seconds.
  - When the user clearly wants Machinen, Cursor consistently calls the MCP tool without manual coaxing.
  - MCP calls no longer error due to argument shape / schema mismatch.

### 2) Allow Cursor scripts to use an env var for Moment Graph namespace
- **Why**: We want to point the MCP tooling at the demo namespace without code changes (and without accidentally querying prod-default).
- **What**:
  - Read `MOMENT_GRAPH_NAMESPACE` from your shell environment (e.g. set in `~/.zshrc`) and have Cursor/MCP forward it when querying so demo data can be isolated.
- **Done when**:
  - Setting `MOMENT_GRAPH_NAMESPACE` is enough to route MCP queries to the chosen namespace.
  - If `MOMENT_GRAPH_NAMESPACE` is unset, behavior remains sane (uses production defaults).

### 3) Fix Discord `idFromName` issue
- **Why**: Name→id resolution is a common “demo-time” failure (and makes the system feel flaky).
- **What**:
  - Make `idFromName` deterministic and robust:
    - Handle ambiguity with clear errors (“multiple matches”) and optional disambiguators.
    - Cache lookups where appropriate.
    - Normalize input (case, punctuation, leading `#`, etc.).
  - Add a small regression test (or a fixture-driven test) if feasible.
- **Done when**:
  - The demo ingestion path never fails on basic name→id resolution.
  - If it can’t resolve, the error suggests the user’s next action (use id, rename, etc.).

### 4) “0 macros also fine”
- **Why**: We’re currently producing low-signal macro moments for Cursor convos that have no technical content (e.g. “thanks”), which pollutes the demo narrative.
- **What**:
  - Treat “0 macro moments synthesized” as a valid outcome (especially for Cursor):
    - Skip smart-linking, moment creation, and vector upserts for that doc.
    - Still update indexing state so the system doesn’t retry forever.
    - Log a clear message so it’s debuggable (“no macros produced; skipping moment graph write”).
- **Done when**:
  - Indexing a doc that yields 0 macros returns success and does not throw.
  - Subsequent resyncs behave idempotently.
  - Cursor convos that are only acknowledgements do not generate “useless” macro moments.

### 5) Populate demo data in an isolated demo namespace on production
- **Why**: Demo needs stable, curated data and linking behavior without polluting existing prod narratives.
- **What**:
  - Create a new namespace for demo data (details TBD) and index only demo artifacts into it.
  - Provide a small “demo seed list” of `r2Key`s (GitHub issue/PR + relevant Discord thread + key Cursor convos).
  - Verify the narrative query outputs the expected timeline in one shot.
- **Done when**:
  - One command (or a short, documented sequence) populates demo data.
  - `/query` produces the narrative timeline reliably and quickly from multiple phrasings.

## Known sharp edge (worth fixing if time permits)
- **Queue sendBatch limit (100)**: We saw a failure when trying to enqueue >100 chunk messages for a large Cursor conversation.
  - This doesn’t block demo if we use `mode:"inline"` resync, but it’s a reliability hole.
  - Fix is to batch queue sends in groups of 100 (or fewer), and/or adjust the scheduler strategy.


