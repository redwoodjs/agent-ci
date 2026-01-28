# Improving Timeline Fit 2026-01-27

## Initiated investigation into timeline fit failures
We are investigating why "timeline fit" practically always returns 0 candidates. The user suspects it might be broken at the candidate selection phase, preventing the system from even deciding on a fit. We also need to prepare for a simulation run with specific "needle" candidates.

**Context:**
- Related to issue 552 and PR 933.
- Focus on RSC requests, pre-fetching, and caching.
- Need to extract/derive documents for a "haystack" (25-50 sample) and include "needles" (known links).
- Discord conversation provided clues about client-side navigation and RSC GET requests.

## Discovered potential causes for 0 candidates
After examining the `candidate_sets` and `timeline_fit` pipelines and reviewing Architecture Blueprints, we found:
1.  **Strict Namespace Filtering**: The `candidate_sets` runner filters vector queries by `childRow._namespace`. In a simulation run `sim-XXXX:namespace`, this properly restricts searches to the current simulation's materialized moments.
2.  **Anchor Token Rules**: Reference to `docs/architecture/chain-aware-moment-linking.md` highlights that candidates with no shared anchors are rejected to favor "work continuity". If anchor extraction is too narrow or missing from synthesized summaries, valid links are dropped.
3.  **Vector Search Latency**: Previous findings suggest timing issues where newly indexed moments aren't yet available for vector query during a fast simulation run.
4.  **Existing Mixed Sampling**: The user pointed out that mixed sampling (manual keys + sampled haystack) is already implemented in `simulation-actions.ts` and `r2_listing`.

## Identified "needle" documents for simulation
We extracted the following R2 keys to use as "needles":
github/redwoodjs/sdk/issues/552/latest.json
github/redwoodjs/sdk/pull-requests/933/latest.json
github/redwoodjs/sdk/pull-requests/530/latest.json
discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json

## Proposed Work Task Blueprint

### Context
Improve "timeline fit" observability to diagnose why candidates are discarded, and use the existing mixed-run capability to verify links between known "needles".

### Directory & File Structure
```text
src/app/pipelines/
├── candidate_sets/
│   └── [MODIFY] engine/simulation/runner.ts
├── timeline_fit/
│   └── [MODIFY] engine/simulation/runner.ts
└── [REVISED] docs/blueprints/simulation-engine.md
```

### Types & Data Structures
No type changes.

### Invariants & Constraints
- **Blueprint Alignment**: Decision logic must follow the "Evidence is required" principle from `linking-and-graph.md`.
- **Visibility**: Every rejection reason must be logged to `simulation_run_events`.

### System Flow
**Refined Investigation Flow:**
1.  **Focused Diagnostic Simulation**: Run a simulation with ONLY the 4 identified "needle" R2 keys (Issue 552, PR 933, PR 530, Discord Thread). No haystack.
2.  **Targeted Logging**: Add minimal logging to `src/app/pipelines/candidate_sets/engine/simulation/runner.ts` to log the raw vector result count and any rejections due to `time-inversion` or `same-document` rules.
3.  **Evidence Inspection**: Check if PR 933 sees Issue 552 as a candidate. If it doesn't even appear in the vector search, we have a retrieval/indexing issue. If it's excluded, we'll see the reason.

## Plan for certainty (Minimal Investigation)
We have added minimal diagnostic logs to `src/app/pipelines/candidate_sets/engine/simulation/runner.ts` and prepared for a 4-document simulation.

### Status
- [x] Implement diagnostic logs (COMPLETED)
- [ ] Fix simulation indexing in `materialize_moments` (PENDING)
- [ ] Trigger focused simulation (PENDING)
- [ ] Inspect logs for vector results and rejections (PENDING)

---

## 2026-01-27: Discovery of Missing Vector Indexing in Simulation

While analyzing the simulation logs showing 0 vector matches, we investigated the `materialize_moments` phase. We discovered that `src/app/pipelines/materialize_moments/engine/simulation/adapter.ts` was manually inserting moments into the Durable Object SQLite database but **skipping vector indexing** in Vectorize. 

This is the root cause: the simulation's "haystack" is never indexed into the vector store, so `candidate_sets` can never find them.

### Updated Goal
Fix simulation indexing and verify candidate generation.

1.  **[ ] Fix Indexing in `materialize_moments`**
    *   Update `adapter.ts` to use `addMoment` from `src/app/engine/databases/momentGraph`.
    *   Validate that `addMoment` correctly handles the simulation namespace.
2.  **[ ] Verify Vector Retrieval**
    *   Re-run the simulation with the 4 needle documents.
    *   Check `debug.vector_raw_results` in the logs to confirm we now get matches.
3.  **[ ] Debug Timeline Fit (if still 0)**
    *   If we have candidates but still 0 fit, use the diagnostic logs to understand why.

## Pivot to 10-Step Workflow and Formalizing the Indexing Discovery

We realized that our previous updates were not strictly following the 10-step workflow protocol. We are now correcting this by ensuring "we" voice and following the sequential steps. 

### Investigation Findings (Step 2 & 3)
We conducted a deep dive into the '0 candidates' issue by examining the logs and the simulation engine code. We confirmed that the  phase in simulation uses a manual Durable Object SQLite insertion path (`src/app/pipelines/materialize_moments/engine/simulation/adapter.ts`) that completely bypasses the `MOMENT_INDEX` (Vectorize). Specifically:
- In production/live paths, `addMoment` is used, which handles both Durable Object SQLite and Vectorize.
- In simulation, the adapter manually calls `momentDb.insertInto("moments")`.
- Because simulation namespaces are isolated (e.g., `sim-XXXX:...`), the lack of indexing means `candidate_sets` finds nothing in that namespace, resulting in 0 matches.

We have verified this by cross-referencing:
1. `src/app/pipelines/materialize_moments/engine/simulation/adapter.ts:218` (Manual DO SQLite insert)
2. `src/app/engine/databases/momentGraph/index.ts:251` (`MOMENT_INDEX.upsert` call in the standard path)

We will now proceed to Step 4: Drafting the Work Task Blueprint.

## Work Task Blueprint: Unify Indexing and Surface Rejections (Step 4)

**Context**:
We are investigating why "timeline fit" returns 0 candidates during simulations. We discovered that the `materialize_moments` phase in simulation is manually inserting moments into Durable Object SQLite but skipping Vectorize indexing. We need to unify the indexing logic using `addMoment` and upgrade the engine's internal logging to surface rejection reasons (like time-order or cycle-prevention) in simulation run events.

**Directory & File Structure**:
```text
src/app/
├── pipelines/
│   ├── materialize_moments/
│   │   └── engine/simulation/
│   │       └── [MODIFY] adapter.ts
│   └── candidate_sets/
│       └── engine/simulation/
│           └── [ALREADY DONE] runner.ts
└── engine/
    └── databases/
        └── momentGraph/
            └── [MODIFY] index.ts
```

**Types & Data Structures**:
- **[NEW] `MomentGraphLogger`**: Interface for routing engine logs to simulation run events.
- **[MODIFY] `MomentGraphContext`**: Add optional `log?: MomentGraphLogger`.

**Invariants & Constraints**:
- **Invariant**: All moments (live or simulation) MUST be indexed in Vectorize via the unified `addMoment` path.
- **Constraint**: Engine internal rejections (time-order/cycles) must be visible in simulation logs, not just hidden in `console.log`.

**System Flow (Snapshot Diff)**:
- **Previous Flow**: `materialize_moments (Sim)` -> Manual SQLite Insert (No Vectorize) -> `candidate_sets` (Zero matches).
- **New Flow**: `materialize_moments (Sim)` -> `addMoment` (SQLite + Vectorize + Logger Injection) -> `candidate_sets` (Matches + Visible rejection reasons if any).

**Suggested Verification (Manual)**:
1. Trigger a simulation run with the 4 "needle" documents.
2. Monitor the `candidate_sets` logs for `debug.vector_raw_results`.
3. Confirm `matchesCount > 0`.

**Tasks**:

- [x] Upgrade `MomentGraphContext` and `addMoment` in `index.ts` to support optional logging. (COMPLETED)
- [x] Refactor `adapter.ts` to use `addMoment` and inject the simulation logger. (COMPLETED)
- [ ] Re-run simulation and verify candidate acquisition and rejection visibility. (PENDING - Deployment required)

## Draft Pull Request: Unify Simulation Indexing and Surface Engine Rejections (Step 10)

### Problem
Simulation runs consistently returned 0 candidates for "timeline fit," even with known matching "needle" documents. Investigation revealed that the `materialize_moments` phase in simulations was bypassing the unified `addMoment` path, skipping Vectorize indexing entirely. Additionally, engine-level link rejections (time-order/cycles) were being lost in `console.log` rather than being surfaced in simulation events.

### Solution
- **Unified Indexing**: Refactored the simulation `materialize_moments` adapter to use the central `addMoment` function, ensuring moments are correctly indexed into Vectorize for the simulation namespace.
- **In-Process Logging**: Introduced `MomentGraphLogger` and updated `addMoment` to route internal rejection reasons (time-order, cycle-prevention) to simulation run events.
- **Blueprint Updates**: codified "Indexing Isolation" and "In-Process Logging" as system invariants in `docs/blueprints/simulation-engine.md`.

### Rationale
Unifying the indexing path ensures that simulation environments behave identically to production regarding retrieval. Surfacing rejections in the event stream eliminates "silent failures" and allows for rapid debugging of linking logic during simulations.

### Verification Plan
- **Manual**: Run a focused simulation with the 4 "needle" documents identified in this worklog.
- **Evidence**: Verify `moment-linker.vector-upsert` and rejection events appear in the simulation event log.
