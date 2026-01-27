# Improving Timeline Fit 2026-01-27

## Initiated investigation into timeline fit failures
### 
We are investigating why "timeline fit" practically always returns 0 candidates. The user suspects it might be broken at the candidate selection phase, preventing the system from even deciding on a fit. We also need to prepare for a simulation run with specific "needle" candidates.

**Context:**
- Related to issue 552 and PR 933.
- Focus on RSC requests, pre-fetching, and caching.
- Need to extract/derive documents for a "haystack" (25-50 sample) and include "needles" (known links).
- Discord conversation provided clues about client-side navigation and RSC GET requests.

## Discovered potential causes for 0 candidates
### 
After examining the `candidate_sets` and `timeline_fit` pipelines and reviewing Architecture Blueprints, we found:
1.  **Strict Namespace Filtering**: The `candidate_sets` runner filters vector queries by `childRow._namespace`. In a simulation run `sim-XXXX:namespace`, this properly restricts searches to the current simulation's materialized moments.
2.  **Anchor Token Rules**: Reference to `docs/architecture/chain-aware-moment-linking.md` highlights that candidates with no shared anchors are rejected to favor "work continuity". If anchor extraction is too narrow or missing from synthesized summaries, valid links are dropped.
3.  **Vector Search Latency**: Previous findings suggest timing issues where newly indexed moments aren't yet available for vector query during a fast simulation run.
4.  **Existing Mixed Sampling**: The user pointed out that mixed sampling (manual keys + sampled haystack) is already implemented in `simulation-actions.ts` and `r2_listing`.

## Identified "needle" documents for simulation
### 
We extracted the following R2 keys to use as "needles":
- Issue 552: `github/redwoodjs/sdk/issues/552/latest.json`
- PR 933: `github/redwoodjs/sdk/pull-requests/933/latest.json`
- PR 530: `github/redwoodjs/sdk/pull-requests/530/latest.json`
- Discord Thread: `discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json`

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

### 
### System Flow
**Refined Investigation Flow:**
1.  **Candidate Selection Logging**: Add `debug.vector_raw_matches` and `debug.exclusion_reason` (time inversion, same doc, namespace mismatch).
2.  **Timeline Fit Benchmarking**: Log `debug.timeline_fit_shared_tokens` and the full LLM payload if veto is used.
3.  **Simulation Execution**: Use the existing UI to run a simulation with the identified "needles" + a 25-50 document sample.

### Architecture Blueprint Revision (Step 6)
We successfully updated `docs/blueprints/simulation-engine.md` and `docs/blueprints/linking-and-graph.md` to reflect the "Audit Trail" requirements and document the existing mixed sampling behavior.

### Implementation (Step 7)
We added extensive logging to:
- `src/app/pipelines/candidate_sets/engine/simulation/runner.ts`
- `src/app/pipelines/timeline_fit/engine/simulation/runner.ts`
- `src/app/pipelines/deterministic_linking/engine/simulation/runner.ts`

### Verification (Step 8)
We've prepared a walkthrough with specific simulation keys and log kinds to watch for.

### Draft PR (Step 10)
**Title:** Enhance Simulation Linking Observability and Blueprint Mixed Sampling

**Problem:** "Timeline fit" often returns 0 candidates in simulations, with little visibility into why.
**Solution:** Added detailed debug logging to all linking phases in simulation. Formalized auditability and mixed sampling in blueprints.
**Verification:** User to run a mixed simulation with known needles and haystack.
