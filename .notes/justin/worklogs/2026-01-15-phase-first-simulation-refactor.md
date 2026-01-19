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

## Progress: moved materialize_moments into phase-first

Changes:

- Added `src/app/engine/phases/materialize_moments/`:
  - core orchestrator
  - simulation adapter
  - simulation runner
- Rewired simulation runner dispatch to import the new materialize_moments phase runner directly (not via `runners/simulation/phases/materialize_moments.ts`).
- Deleted the old files:
  - `src/app/engine/adapters/simulation/adapters/materialize_moments_adapter.ts`
  - `src/app/engine/runners/simulation/phases/materialize_moments.ts`
  - `src/app/engine/core/indexing/materialize_moments_orchestrator.ts`

Check:

- `pnpm -s build` passes after this move.

## Progress: moved linking phases into phase-first runners

Changes:

- Added phase-first simulation runners:
  - `src/app/engine/phases/deterministic_linking/simulation/runner.ts`
  - `src/app/engine/phases/candidate_sets/simulation/runner.ts`
  - `src/app/engine/phases/timeline_fit/simulation/runner.ts`
- Updated `src/app/engine/runners/simulation/runner.ts` to import these runners directly from `phases/*`.
- Deleted the old simulation runner files for these phases from `src/app/engine/runners/simulation/phases/`.

Follow-up:

- candidate_sets and timeline_fit still have port wiring (vector, LLM call) in the phase runner. Next step is to push that further down behind ports so the simulation adapter/runner stays boring.

## Progress: micro_batches adapter no longer calls LLM/vector directly

Changes:

- Moved micro moment materialization (paths, embeddings, timeRange, upsert) into the micro_batches core orchestrator.
- Updated the micro_batches simulation runner to supply the LLM/vector/moment-graph write ports, so the simulation adapter no longer imports those modules directly.

Check:

- `pnpm -s build` passes after this refactor.

## Progress: build passes; types has unrelated failures

Ran:

- `pnpm -s build`
- `pnpm -s types`

Notes:

- build passes.
- types fails in a bunch of places outside the simulation refactor slice (vscode-extension, wsproxy, some audit pages, etc).
- I fixed the type errors that were introduced by the phase core port refactors (namespace prefix helper typing and micro_batches/macro_synthesis port shapes), then stopped.

## Progress: macro_classification core owns gating + classification flow

The macro_classification simulation runner and adapter were still owning too much of the flow. In particular, classification behavior was effectively controlled outside the phase core, and the runner had previously drifted toward calling prompt helpers.

Changes:

- Moved the per-document macro stream loop into `src/app/engine/phases/macro_classification/core/orchestrator.ts`.
- The phase core now:
  - gates macro moments per stream using the existing gating logic
  - runs the classification call through a single injected `callLLM` port
  - mutates macro moments with classification fields
- The simulation runner now only provides a `callLLM` port wrapper (alias + temperature) and calls the adapter.
- The simulation adapter loads/persists simulation rows and delegates the stream-level work to the phase core.

Check:

- `pnpm -s build` passes after this refactor.

## Progress: macro_synthesis core owns per-document orchestration

macro_synthesis was still doing the per-document logic in the simulation adapter (reuse checks, assembling micro items, calling synthesis, normalizing and persisting output). That made it hard to keep core/adapter boundaries consistent across simulation and live paths.

Changes:

- Added `runMacroSynthesisForR2Key` in `src/app/engine/phases/macro_synthesis/core/orchestrator.ts` to own:
  - unchanged/error skipping
  - micro stream hash computation and reuse check
  - micro item assembly from moment graph (when available) or micro batch cache
  - calling `computeMacroSynthesisForDocument`
  - stream normalization and persistence via ports
- The simulation adapter now implements the required ports (db reads/writes, moment graph reads, plugin prompt context loading) and aggregates counters.
- The simulation runner now supplies the LLM-backed `synthesizeMicroMomentsIntoStreams` implementation, so the adapter no longer imports it directly.

Check:

- `pnpm -s build` passes after this refactor.

## Plan: registry cutover + shim deletions + boundary cleanup

This is the next slice to align with the handoff brief’s registry-driven wiring and no-shims direction.

Work:

- Create a single server-side source of truth for the ordered phase list and runner mapping.
  - Use it to drive the simulation runner dispatch (instead of scattered imports / ad-hoc maps).
  - Use it to drive server artifact route wiring (so phases and artifacts stay in sync).
  - Keep the UI view registry as a separate concern for now, but ensure it derives its phase order from the same canonical list.

- Do a hard cutover and delete shims after imports are updated:
  - `src/app/engine/core/indexing/ingest_diff_orchestrator.ts`
  - `src/app/engine/core/indexing/micro_batches_orchestrator.ts`
  - `src/app/engine/runners/simulation/phases/ingest_diff.ts`
  - `src/app/engine/runners/simulation/phases/micro_batches.ts`
  - `src/app/engine/runners/simulation/phases/macro_synthesis.ts`
  - Any additional re-export shims found during import rewrites.

- Finish enforcing the adapter/orchestrator boundary in the remaining phase-first runners:
  - candidate_sets: core owns orchestration; vector query is behind ports; runner stays thin; adapter stays I/O.
  - timeline_fit: core owns orchestration and optional LLM veto via a port; runner stays thin; adapter stays I/O.
  - deterministic_linking: core owns orchestration; runner stays thin; adapter stays I/O.

Gates for this slice:

- `pnpm -s build`
- leave simulation tests for later if the dev/proxy startup still blocks them.

## Switch: phase bundles move under src/app/phases/<phase>/engine + web

The handoff brief structure is now:

- `src/app/phases/<phaseId>/engine/{core,live,simulation}/...`
- `src/app/phases/<phaseId>/web/{ui,routes}/...`

Next steps:

- inventory the current phase-first files under `src/app/engine/phases/<phase>/...`
- move them into `src/app/phases/<phase>/engine/...` without changing behavior
- update imports and centralized wiring (runner dispatch, routes, UI registry) so there is one canonical phase path
- keep `pnpm -s build` passing after the move

## Progress: moved phase-first code into src/app/phases/<phase>/engine

Moved the existing phase-first phase implementations out of `src/app/engine/phases/` into:

- `src/app/phases/<phase>/engine/core/*`
- `src/app/phases/<phase>/engine/live/*`
- `src/app/phases/<phase>/engine/simulation/*`

Also moved `src/app/engine/phases/README.md` to `src/app/phases/README.md` and updated it for the `engine/` + `web/` split.

Follow-up in this slice:

- update all imports and any re-export shims that still point at the old phase paths
- run `pnpm -s build`

## Check: build after moving phases

- `pnpm -s build` passes after moving phase code to `src/app/phases/*`.

## Plan: delete shims instead of maintaining them

I updated shim import targets during the move so the repo still built, but these shims are not meant to stick around.

Next slice:

- Locate imports that still target the shim modules (engine core re-exports, simulation runner phase re-exports, simulation adapter re-exports).
- Rewrite those imports to point directly at `src/app/phases/<phase>/engine/...`.
- Delete the shim files once there are no remaining imports.
- Gate with `pnpm -s build`.

## Noticed Phase A is still present in live and simulation codepaths

I dug into why `PhaseAOrchestrator` still exists and where it is used.

What it does (semantics):

- calls plugins to prepare a source document
- computes the moment graph namespace (via plugins, plus optional prefix)
- splits the document into chunks (via plugins)
- loads previously processed chunk hashes and filters to new chunks (live path)
- chunks the chunks into micro computation batches

This is closer to 'document preparation + chunk diff + chunk batching' than to any named pipeline phase.

How it relates to current simulation phases:

- The `ingest_diff` pipeline is an etag diff (head R2 object etag vs last stored etag).
- `PhaseAOrchestrator` is not that. It prepares the document and chunks for downstream phases.
- Simulation `micro_batches` currently calls `runPhaseADocumentPreparation` directly (for replay-style processing), so the naming bleeds into simulation too.
- The `ingest_diff` simulation runner still logs 'Phase A ingest+diff' in an error message, which looks like an old label that no longer matches the code structure.

Next step I think makes sense:

- Rename `PhaseAOrchestrator` to a semantic name (document preparation / indexing preparation).
- Move it under `src/app/engine/indexing/` (it already houses plugin pipeline helpers), and update call sites.
- Update the `ingest_diff` runner error message to stop referencing Phase A.

I also want to rename `src/app/engine/adapters/{live,simulation}` to `src/app/engine/{live,simulation}` since those folders are composition/runtime code, not per-port adapters.

## Moved live and simulation wiring out of engine/adapters

I moved wiring/runtime modules out of `src/app/engine/adapters/`:

- live linking wiring moved to `src/app/engine/live/`
- simulation state runtime moved to `src/app/engine/simulation/`

This is mostly a path + naming change. The code is still doing the same work, but the directory name now matches the fact that these modules are:

- not phase adapters
- not pure port implementations
- mostly runtime / persistence code for the engine

I deleted the old `src/app/engine/adapters/simulation/*` files after updating imports, and kept `pnpm -s build` passing.

## Where we ended up (handoff notes)

This is a catch-up writeup intended to let someone else pick up the work without having to reconstruct the history from git archaeology.

### What we were trying to fix

The refactor started from the brief: simulation should match the older hardened indexing semantics (Jan 2026 reference worktree), while moving to a phase-first, registry-driven structure and keeping strict boundaries:

- core orchestrators own control flow and call injected ports
- adapters should be I/O only (read inputs, call core, persist outputs)
- runners should be thin (phase start/end, status transitions, call adapter)
- no shims in the long-lived state
- avoid baking source-specific logic (discord/github/cursor) into pipelines - that belongs in plugins

The behavioral bugs motivating the refactor were around macro streams and linking:

- macro titles/summaries drifting from the hardened prompts
- a broken invariant where 0 micro moments could still yield macro moments (fabrication/placeholder behavior)
- non-canonical micro paths causing macro microPaths to not resolve
- boundary drift (LLM/vector calls appearing in runners/adapters instead of core)

### Major structure decisions we made

- We renamed the top-level phase folder to `pipelines` (instead of `phases`) to make it feel like a first-class app subsystem.
- We discussed switching phase IDs and directory names to kebab-case, but deferred it because phase IDs are persisted (simulation_runs.current_phase, etc). We leaned toward keeping persisted IDs stable and only changing directory names later, or doing a compatibility map in normalizePhase if/when we change them.
- We decided the plugin system (discord/github/cursor/default + scope router) should remain the place for source-specific behavior, and pipelines should stay source-agnostic.
- We decided that the label 'Phase A' is obsolete and should be removed, because it no longer maps cleanly onto a named pipeline phase.

### What Phase A turned out to be

We found that 'Phase A' was not the `ingest_diff` phase:

- `pipelines/ingest_diff` is etag diffing (R2 head etag vs previous etag).
- The old 'Phase A orchestrator' was doing document preparation and chunk splitting/diffing for downstream phases, plus it was computing the moment graph namespace via plugins (including the redwood scope router).

So we removed the Phase A naming and moved it to a semantic location.

### Concrete code changes we made (high signal)

#### 1) Removed Phase A naming, moved to indexing helpers

- Deleted `src/app/engine/core/indexing/phaseAOrchestrator.ts`
- Added `src/app/engine/indexing/documentPreparation.ts`
  - `runIndexingDocumentPreparation` is the replacement for `runPhaseADocumentPreparation`
- Updated call sites in:
  - `src/app/engine/engine.ts` (live indexing flow)
  - `src/app/pipelines/micro_batches/engine/simulation/adapter.ts` (simulation replay-style processing)
- Updated `pipelines/ingest_diff` runner’s error message to stop referencing 'Phase A ingest+diff'.

#### 2) Made document preparation stop owning micro-batch chunking

We had a design question: document preparation was also doing 'chunkChunksForMicroComputation'. That felt like a micro-batches concern.

We chose to move it out:

- `runIndexingDocumentPreparation` now returns:
  - document
  - indexingContext
  - effectiveNamespace
  - chunks + newChunks
  - oldChunkHashes
- Chunk batching is computed at the call sites that actually need it:
  - live `engine.ts` computes chunk batches just before micro computation
  - simulation `micro_batches` adapter computes chunk batches just before calling the micro_batches core orchestrator

This kept behavior the same (same batching function + env-derived limits), while making the boundaries less confusing.

#### 3) Verified plugin routing and namespace scoping was actually wired

We specifically checked that:

- engine context includes `redwoodScopeRouterPlugin` and it is used during indexing namespace selection
- source-specific behavior (chunk splitting, micro prompt context, document prep) is routed through plugin hooks and the plugin pipeline
- pipelines do not have explicit branching on document.source (at least from the quick grep pass)

This was important because baking discord/github logic into pipelines would have been a major regression.

#### 4) Renamed 'adapters' folders that were really runtime/wiring code

We noticed a naming mismatch:

- `src/app/engine/adapters/live/linking.ts` was a composition entrypoint that wires multiple ports (moment reads, vector query, LLM call) and calls a core linking decision.
- `src/app/engine/adapters/simulation/*` is mostly simulation runtime persistence and orchestration helpers (db, migrations, run events, progress, artifact queries).

Those are not phase adapters and not single-port implementations, so the folder name 'adapters' was misleading.

We moved them:

- `src/app/engine/live/linking.ts` now houses the live linking wiring entrypoint
- `src/app/engine/simulation/*` now houses the simulation runtime modules
- Deleted the old `src/app/engine/adapters/live/*` and `src/app/engine/adapters/simulation/*`

We updated all imports across:

- `src/app/engine/runners/simulation/runner.ts`
- pipeline simulation runners + adapters that used simulation runtime types/db/logger
- `src/app/engine/databases/simulationState/*` wrapper exports
- `src/app/pages/audit/subpages/simulation-runs-page.tsx` (view registry + progress summary)

`pnpm -s build` passes after this cutover.

Hurdle: while doing the move I accidentally ended up with duplicated content in `engine/simulation/runArtifacts.ts` (a full copy pasted twice), which caused directive scan/build failures with 'multiple exports with the same name'. We fixed it by rewriting `runArtifacts.ts` back down to a single set of exports and re-running build.

#### 5) Types status

We have been using `pnpm -s build` as the main gate because it catches a lot of wiring errors fast.

`pnpm -s types` has a bunch of unrelated failures (vscode extension, wsproxy, various audit pages). The approach we took was:

- fix type errors that were introduced by the refactor slice
- leave the rest for later unless they block the refactor

Examples we fixed in-slice:

- `engine.ts` catch block was using `document.id` and `momentGraphContext` when they were not in scope in the catch. We changed it to store an audit document id/context once available, and fall back to console.error otherwise.
- `utils/provenance.ts` was importing MicroMoment from the wrong place; now it imports `MicroMoment` from `databases/momentGraph`.
- `engine/runners/simulation/runner.ts` was missing a `SimulationPhase` type import.

### Where things are now

Build:

- `pnpm -s build` passes.

Structure:

- pipelines are under `src/app/pipelines/*`
- live linking wiring is under `src/app/engine/live/*`
- simulation runtime is under `src/app/engine/simulation/*`
- indexing preparation helpers are under `src/app/engine/indexing/*`

Naming:

- 'Phase A' label removed from the main codepaths (replaced by document preparation).

### What still looks unfinished / what to do next

1) Finish the registry-driven wiring cutover.
   - There is still scattered wiring for simulation phases and artifacts in a few places.
   - There is a `simulationPhases` list, but phase runner mapping and UI view wiring can still drift.
   - Goal is a single canonical phase registry driving runner dispatch and artifact routes, with UI deriving ordering.

2) Boundary enforcement for candidate_sets and timeline_fit.
   - These were previously noted as still having vector/LLM calls in runners. Some of that may still exist and needs to be pushed behind core ports so runners/adapters stay boring.

3) Decide on kebab-case phase IDs.
   - If we do it, it needs a compatibility strategy for persisted phases (`normalizePhase` already has a legacy map for older phase labels).
   - If we only want kebab-case directory names but keep stable IDs, then we need an explicit mapping layer between IDs and folder paths.

4) Cleanup/rmdir.
   - There have been multiple directory moves and deletions. It’s worth doing a pass to remove now-empty directories (and confirm no old shims remain).

5) Tests.
   - Earlier we tried `pnpm -s test:simulation` and hit wrangler/dev session networking issues. We deferred tests and used build/types selectively. Simulation tests should be reattempted once the local dev forcing is stable.

