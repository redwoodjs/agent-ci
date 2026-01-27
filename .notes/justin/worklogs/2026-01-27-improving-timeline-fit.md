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
- [ ] Trigger focused simulation (PENDING)
- [ ] Inspect logs for vector results and rejections (PENDING)
