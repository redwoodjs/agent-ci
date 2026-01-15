# 2026-01-15-phase-first-simulation-refactor

## Picked up the handoff brief and re-read the Jan 13 worklog

The goal is to keep refactoring `machinen_faster-better-backfill` so the simulation pipeline matches the older, hardened indexing semantics from `machinen_main-jan-15-2026`, while finishing the phase-first layout and keeping the adapter/orchestrator boundary strict.

The failure modes that triggered this still frame what I am checking for:

- macro synthesis must be LLM-driven and never fabricate placeholder macro outputs
- 0 micro moments must produce 0 macro streams
- micro moment paths must be canonical so macro `microPaths` resolve
- adapters must be storage and retrieval only; orchestration lives in core orchestrators via injected ports
- phase wiring should be registry-driven so adding/removing phases is a centralized edit

## Mapped the current repo state against the brief

In `machinen_faster-better-backfill`, phase-first directories exist for:

- `src/app/engine/phases/ingest_diff/`
- `src/app/engine/phases/micro_batches/`
- `src/app/engine/phases/macro_synthesis/`
- `src/app/engine/phases/macro_classification/`

The simulation phase list is still the 8-phase sequence:

- ingest_diff
- micro_batches
- macro_synthesis
- macro_classification
- materialize_moments
- deterministic_linking
- candidate_sets
- timeline_fit

The simulation runner dispatch (`src/app/engine/runners/simulation/runner.ts`) still imports phase runners from `src/app/engine/runners/simulation/phases/*` for all phases, including those that are already phase-first. That folder still contains:

- `materialize_moments.ts`
- `deterministic_linking.ts`
- `candidate_sets.ts`
- `timeline_fit.ts`

This matches the brief’s “unmigrated phases still live in the old simulation runner folder and contain business logic” issue, but it also suggests the already-migrated phase-first runners are not yet the dispatch targets.

There is also a simulation adapter directory (`src/app/engine/adapters/simulation/adapters/`) that contains adapter modules for:

- macro_classification
- macro_synthesis
- materialize_moments
- micro_batches

This looks like partially-completed phase-first wiring (some phases have both a phase-first folder and an older adapter module), so I need to confirm which entrypoints are the ones actually used by the runner and routes.

## Plan for the next slice (before changing code)

I’m going to do a small “wiring audit” across:

- simulation runner dispatch + each phase runner file to see where orchestration actually lives today
- the simulation routes and the UI registry to see how artifacts and views are sourced
- the remaining “shim” modules called out in the brief, to verify whether they still exist and are referenced

After that, I’ll write a concrete cutover plan (files to move, imports to rewrite, shims to delete) and list the test gates to run at each step.

## Checked the already-migrated phase-first code for boundary violations

This is the part that tends to regress: having a phase-first directory does not mean the adapter/orchestrator boundary is being respected.

Findings so far:

- `micro_batches` (phase-first, simulation adapter)
  - `src/app/engine/phases/micro_batches/simulation/adapter.ts` imports vector helpers (`getEmbeddings`, `getEmbedding`) and uses them directly while writing micro moments.
  - It also imports and calls `computeMicroMomentsForChunkBatch` directly (LLM work), with a `useLlm` flag controlling whether it runs.
  - This means the simulation adapter contains both vector calls and LLM calls, and the phase orchestration is not fully expressed in core via injected ports.

- `macro_synthesis` (phase-first, simulation adapter)
  - `src/app/engine/phases/macro_synthesis/simulation/adapter.ts` calls `synthesizeMicroMomentsIntoStreams` directly (LLM work is inside that helper) and contains the control flow for reuse vs recompute, micro-moment loading, and stream normalization.
  - This is phase logic (and LLM invocation) living in the simulation adapter rather than in the core orchestrator with injected ports.

- `macro_classification` (phase-first, simulation adapter)
  - `src/app/engine/phases/macro_classification/simulation/adapter.ts` imports `classifyMacroMoments` directly (LLM) and passes it into the core helper wrapper.
  - The control flow and the port wiring are still inside the adapter, and the adapter is directly responsible for the LLM call.

- `materialize_moments` (not phase-first, simulation adapter module)
  - The simulation phase runner still calls `runMaterializeMomentsAdapter` from `src/app/engine/adapters/simulation/adapters/materialize_moments_adapter.ts`.
  - This adapter imports plugin prep (`prepareDocumentForR2Key`) to recover document identity fields for provenance normalization, and calls the core `materialize_moments_orchestrator`.
  - There is a small correctness issue in this file: a duplicated import line for the provenance helpers.

- Remaining linking phases (not phase-first, old runner folder)
  - `candidate_sets` runner imports `getEmbedding` and calls the vector index directly (`MOMENT_INDEX.query`).
  - `timeline_fit` runner imports `callLLM` and assembles an LLM prompt in the runner.
  - Both are direct violations of the “no vector/LLM in adapters/runners” constraint from the brief and the repo rule.

Net: the “already migrated” code still has the exact boundary problems the refactor is meant to eliminate. The follow-up work needs to include fixing the already-migrated phases, not only moving the remaining ones.

## Re-checked the old hardened reference prompts and invariants

Reference worktree: `machinen_main-jan-15-2026`.

Canonical behaviors to preserve:

- Micro moment generation (`src/app/engine/subjects/computeMicroMomentsForChunkBatch.ts`)
  - Returns `[]` for empty chunk batches.
  - Uses an LLM prompt that enforces strict output line format `S<index>|<summary>`, sequential indices, and 1-12 items.
  - Parsing logic rejects output that looks like meta summarization (example: lines starting with "Content about:").

- Macro synthesis (`src/app/engine/synthesis/synthesizeMicroMoments.ts`)
  - Returns `[]` when `microMoments.length === 0`.
  - The synthesis prompt includes explicit exclusion rules (omit bot/admin chatter and other low-signal content entirely).
  - Stream synthesis exists (`synthesizeMicroMomentsIntoStreams`) and similarly returns `[]` for no micro moments.

- Macro classification (`src/app/engine/subjects/classifyMacroMoments.ts`)
  - Returns `[]` when `macroMoments.length === 0`.
  - Uses an LLM prompt requiring a single JSON array with the classification fields and parses it as JSON.

How this maps onto the refactor constraints:

- The old engine calls LLM helpers directly (it predates the ports pattern). In the phase-first refactor, these LLM calls still need to happen, but they should move behind injected ports so the core orchestrator owns control flow and the adapters only supply the I/O implementation for the port.

## Planned cutover tasks (based on the audit)

This is the concrete work needed to get back to the brief’s constraints, including fixing the already-migrated phases.

- Fix phase-first boundary violations in already-migrated phases
  - micro_batches
    - Move embedding and vector index usage behind ports owned by `phases/micro_batches/core/orchestrator.ts`.
    - Move micro moment batch persistence (moment graph writes) behind ports, still called by core.
    - Make `phases/micro_batches/simulation/adapter.ts` do only: read doc state + load inputs + call core + write simulation rows.
  - macro_synthesis
    - Move stream synthesis control flow behind ports owned by `phases/macro_synthesis/core/orchestrator.ts` (including the LLM-backed synthesis helper call).
    - Make `phases/macro_synthesis/simulation/adapter.ts` I/O only.
  - macro_classification
    - Move classification LLM call behind a core-owned port and make the simulation adapter I/O only.
  - materialize_moments
    - Create `src/app/engine/phases/materialize_moments/` and move the simulation phase wiring there (core orchestrator + simulation adapter + simulation runner).
    - Remove the duplicated import in `adapters/simulation/adapters/materialize_moments_adapter.ts` during the move, and ensure the materialization path does not invent placeholder titles/summaries.

- Migrate remaining phases into phase-first bundles
  - deterministic_linking
  - candidate_sets
  - timeline_fit

For each of these:

- core owns orchestration and calls injected ports (moment reads/writes, vector query, optional LLM veto)
- simulation adapter is DB/moment I/O only
- simulation runner is thin (phase start/end, status transitions, call adapter)

- Registry / wiring cutover
  - Update the simulation runner dispatch to import phase runners directly from `src/app/engine/phases/<phase>/simulation/runner.ts` (not via `runners/simulation/phases/*` shims).
  - Keep a single canonical ordered phase list and derive:
    - runner dispatch mapping
    - server artifact routes
    - UI view list
    - progress summary phase ordering

- Delete shims after imports are updated (no compat layer)
  - `src/app/engine/core/indexing/ingest_diff_orchestrator.ts`
  - `src/app/engine/core/indexing/micro_batches_orchestrator.ts`
  - `src/app/engine/runners/simulation/phases/ingest_diff.ts`
  - `src/app/engine/runners/simulation/phases/micro_batches.ts`
  - `src/app/engine/runners/simulation/phases/macro_synthesis.ts`
  - and any additional re-export shims encountered during the moves

- Gates
  - `pnpm build`
  - `MACHINEN_TEST_FORCE_DEV=1 pnpm -s test:simulation`

