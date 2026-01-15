# 2026-01-15 — Phase-first simulation refactor: handoff brief (machinen_faster-better-backfill)

This is a **complete handoff brief** intended to be pasted into a fresh conversation as the only context.

## Why this exists (problem statement)

We are refactoring `machinen_faster-better-backfill` so the **simulation pipeline** matches the **old, hardened, LLM-driven indexing logic** from `machinen_main-jan-15-2026`, while also restructuring the codebase to be **phase-first** and **registry-driven**.

Key failures that triggered this work:

- **Wrong macro titles/summaries**: placeholder / ad-hoc fallbacks like `"Synthesis for ..."` appeared when macro synthesis wasn’t using the real LLM prompt or when micro moments were empty.
- **Broken invariant**: **0 micro moments must lead to 0 macro moments/streams** (no fabricated placeholders).
- **Broken microPaths**: simulation used non-canonical micro moment `path` values, so macro `microPaths` could not be resolved.
- **Architecture drift**: “adapters” accumulated business logic and direct LLM calls. Design intent is: **adapters do storage/retrieval only; core orchestrators own control flow and call injected ports**.
- **Phase wiring drift**: adding phases required edits across UI, runner dispatch, routes, artifacts, etc. We want a **registry-driven system** so adding/removing phases is a centralized edit.

## Worktrees & canonical references

- **Target refactor worktree (current)**: `/Users/justin/rw/worktrees/machinen_faster-better-backfill`
- **Old hardened reference (canonical prompts + sequencing)**: `/Users/justin/rw/worktrees/machinen_main-jan-15-2026`

When in doubt about prompts/invariants, treat the `machinen_main-jan-15-2026` implementation as the source of truth.

## Canonical “old hardened” code locations (machinen_main-jan-15-2026)

These are the files that define the “real” LLM prompts and indexing invariants we are re-adopting:

- **Micro moment generation prompt**: `machinen_main-jan-15-2026/src/app/engine/subjects/computeMicroMomentsForChunkBatch.ts`
  - Strict format `S<index>|<summary>`, 1–12 items, strong attribution rules.
- **Macro synthesis prompt + parse**: `machinen_main-jan-15-2026/src/app/engine/synthesis/synthesizeMicroMoments.ts`
  - Includes explicit exclusion rules (“omit bot/admin chatter”, “omit low signal entirely”).
  - Enforces: if `microMoments.length === 0` returns `[]`.
  - Produces titles + summaries via LLM (macro titles do **not** come from cheap summarizer utilities).
- **Macro classification prompt + parse**: `machinen_main-jan-15-2026/src/app/engine/subjects/classifyMacroMoments.ts`
  - JSON array output with `momentKind`, `isSubject`, `subjectKind`, `subjectEvidence`, `momentEvidence`, `confidence`.
- **Overall sequencing + deterministic macro gating**: `machinen_main-jan-15-2026/src/app/engine/engine.ts`
  - Contains the “live engine” orchestration and the deterministic macro gating logic (noise regexes, importance thresholds, capping).

## Target architecture (non-negotiable constraints)

### Phase-first directory layout

All code for a phase should be co-located under:

`src/app/engine/phases/<phaseId>/`

Recommended substructure:

- `core/` — **orchestrator(s)** + pure helpers
- `live/` — live port implementations + thin adapters
- `simulation/` — simulation port implementations + thin adapters + simulation runner
- `ui/` — UI view(s) for the phase
- `routes/` (optional) — phase-specific API routes (or registry-driven generation)

### Core vs adapters (strict separation)

Definitions:

- **Orchestrator (core)**: owns phase control-flow, calls injected ports, returns structured outputs and audit.
- **Ports**: interfaces for I/O and external effects (DB reads/writes, moment graph reads/writes, LLM calls, vector queries, config/env).
- **Adapter**: implements ports for an environment (simulation vs live).

Hard rule:

- **Adapters must not contain business logic or phase control-flow** beyond “read inputs → call core → persist outputs”.
- **Adapters must not directly call LLMs** (LLM calls belong in core orchestrators via injected ports).
- **Adapters must not include deterministic gating/filtering logic** (belongs in core).

### Registry-driven wiring

Goal: adding/removing a phase should be a **single, centralized edit**, not changes scattered across:

- runner dispatch
- API routes (artifact endpoints)
- UI navigation and view rendering
- progress calculation / metrics

At minimum, have:

- **Server-side registry**: phase ordering + runner mapping + artifact fetchers
- **UI registry**: view tabs + rendering + link generation

Prefer a **single shared registry** that can feed both, or two co-located registries near `src/app/engine/phases/`.

## Current phase list (simulation)

Canonical list is in:

- `machinen_faster-better-backfill/src/app/engine/adapters/simulation/types.ts` (`simulationPhases`)

Current ordered phases:

1. `ingest_diff`
2. `micro_batches`
3. `macro_synthesis`
4. `macro_classification`
5. `materialize_moments`
6. `deterministic_linking`
7. `candidate_sets`
8. `timeline_fit`

Simulation artifacts tables (by phase) are reflected in `SimulationDatabase` row types in that same file.

## What has been migrated to phase-first already (machinen_faster-better-backfill)

Phase-first directories currently exist:

`machinen_faster-better-backfill/src/app/engine/phases/`

- `ingest_diff/`
  - `core/orchestrator.ts`
  - `simulation/runner.ts`
- `micro_batches/`
  - `core/orchestrator.ts`
  - `simulation/adapter.ts`
  - `simulation/runner.ts`
- `macro_synthesis/`
  - `core/orchestrator.ts`
  - `live/adapter.ts`
  - `simulation/adapter.ts`
  - `simulation/runner.ts`
- `macro_classification/`
  - `core/orchestrator.ts`
  - `simulation/adapter.ts`
  - `simulation/runner.ts`

### Known shims that still exist (should be deleted in the “hard cutover”)

These are re-export shims that remain from an incremental migration approach:

- `src/app/engine/core/indexing/ingest_diff_orchestrator.ts`
- `src/app/engine/core/indexing/micro_batches_orchestrator.ts`
- `src/app/engine/runners/simulation/phases/ingest_diff.ts`
- `src/app/engine/runners/simulation/phases/micro_batches.ts`
- (also exists) `src/app/engine/runners/simulation/phases/macro_synthesis.ts` (shim)

Design intent going forward: **no shims**. Once imports are updated, delete these files.

## The big semantic fixes already made (the “titles/synthesis” incident)

### 1) Removed placeholder macro outputs

The system previously created ad-hoc macro titles like `"Synthesis for..."` when:

- macro synthesis was run with a `useLlm=false` flag, or
- micro moments were empty / missing.

Fix: macro synthesis is now **always LLM-driven** and produces **zero streams** when there are **zero micro moments** (or when synthesis fails), matching `machinen_main-jan-15-2026` invariants.

### 2) Canonical micro moment `path` scheme

Canonical path scheme:

- `chunk-batch:${chunkBatchHash}:${index}`

Simulation now persists micro moments into the moment graph with canonical paths and source metadata so macro synthesis can resolve `microPaths`.

### 3) Macro classification is its own simulation phase

`macro_classification` was introduced as a distinct phase with its own artifact storage.

### 4) Deterministic macro gating matches old engine

The deterministic macro gating logic (noise pattern filtering, importance thresholding, capping) was replicated from `machinen_main-jan-15-2026/src/app/engine/engine.ts` into:

- `src/app/engine/phases/macro_classification/core/orchestrator.ts`

This is the correct location (core), not adapter.

## Where the current system is still “wrong” (remaining drift / violations)

### 1) Unmigrated phases still live in the old simulation runner folder and contain business logic

These phase runners still live in `src/app/engine/runners/simulation/phases/` and currently mix orchestration + ports + logic:

- `materialize_moments.ts`
- `deterministic_linking.ts`
- `candidate_sets.ts`
- `timeline_fit.ts`

Examples of architectural violations to eliminate:

- `candidate_sets.ts` directly imports vector functionality (`getEmbedding`) and calls vector index query.
- `timeline_fit.ts` imports `callLLM` and performs an LLM veto inside the runner.
- `deterministic_linking.ts` imports deterministic linking logic and does orchestration inline.

These must be migrated into phase-first bundles and inverted so the **core orchestrator owns flow** and **ports are injected**.

### 2) Shims still exist (see above)

Need a hard cutover: update imports → delete shims.

### 3) Registry is only partially centralized

There is a UI view registry:

- `src/app/engine/adapters/simulation/phaseRegistry.ts` (exports `simulationRunViews`)

But we still want:

- a **server-side registry** (phases, artifacts, runners)
- ideally co-located with phase bundles (or generated from them)

## Current registry-ish wiring (machinen_faster-better-backfill)

Known centralized components:

- **UI views registry**: `src/app/engine/adapters/simulation/phaseRegistry.ts`
  - `simulationRunViews` includes `documents`, `micro-batches`, `macro-outputs`, `macro-classifications`, `materialized-moments`, `link-decisions`, `candidate-sets`, `timeline-fit-decisions`
- **UI page uses registry**: `src/app/pages/audit/subpages/simulation-runs-page.tsx`
- **Server routes generated from registry**: `src/app/engine/routes/simulation.ts`
- **Runner dispatch map-driven**: `src/app/engine/runners/simulation/runner.ts`

## Phase semantics (what each phase does)

This section is the contract for each phase. Simulation should mirror live semantics as much as possible.

### Phase A — `ingest_diff`

- **Inputs**: run config (currently `r2Keys`), R2 object metadata (etag)
- **Outputs (simulation DB)**: `simulation_run_documents` rows per `(run_id, r2_key)`
  - stores etag, changed flag, error state
- **Purpose**: establish doc scope + stable identity so later phases can skip unchanged docs.
- **LLM?**: no

### Phase B — `micro_batches`

- **Inputs**: document chunks (from live chunking logic / plugins), chunk batch metadata
- **Outputs (simulation DB)**: `simulation_run_micro_batches` rows per batch
- **Side effect**: upsert micro moments into the moment graph with canonical micro `path` and provenance (`chunkBatchHash`, `chunkIds`, `timeRange`, author, etc).
- **LLM?**: yes (micro-moment generation prompt must match `machinen_main-jan-15-2026/.../computeMicroMomentsForChunkBatch.ts`)

### Phase C — `macro_synthesis`

- **Inputs**: micro moments (prefer reading from moment graph so paths resolve)
- **Outputs (simulation DB)**: `simulation_run_macro_outputs`
  - `streams_json` + synthesis audit + anchors + any gating audit (if present)
- **Invariant**: 0 micro moments → 0 streams; no placeholders.
- **LLM?**: yes (prompt must match `machinen_main-jan-15-2026/.../synthesizeMicroMoments.ts`)

### Phase D — `macro_classification`

- **Inputs**: macro moments (from macro synthesis), plus deterministic gating configuration
- **Outputs (simulation DB)**: `simulation_run_macro_classified_outputs`
  - stores gated streams and classification JSON
- **Core responsibilities**:
  - deterministic gating (noise regexes, min importance, cap max-per-stream) copied from old `engine.ts`
  - LLM classification copied from old `classifyMacroMoments.ts`
- **LLM?**: yes (classification prompt must match old)

### Phase E — `materialize_moments`

- **Inputs**: macro moments (post-gating/classification)
- **Outputs (simulation DB)**: `simulation_run_materialized_moments` mapping rows from `(r2_key, stream_id, macro_index)` → `moment_id`
- **Side effects**: writes macro moments into moment graph DB as “moments”
  - titles/summaries/createdAt/sourceMetadata/isSubject/subjectKind/evidence/etc
- **LLM?**: no (should be pure materialization of prior LLM outputs)

### Phase F — `deterministic_linking`

- **Inputs**: materialized moments (child moments), macro anchors, prior/prev moment in stream
- **Outputs (simulation DB)**: `simulation_run_link_decisions`
  - outcome = attached / rejected / unlinked
  - evidence (rule id + evidence payload)
- **Side effects**: sets `parentId` on moments in moment graph
- **LLM?**: no (deterministic rules only)

### Phase G — `candidate_sets`

- **Inputs**: unparented root moments, vector index, moment graph rows
- **Outputs (simulation DB)**: `simulation_run_candidate_sets` (candidates_json + stats_json)
- **Side effects**: none (just candidate retrieval + stats)
- **LLM?**: no

### Phase H — `timeline_fit`

- **Inputs**: candidate sets + child moments + candidate rows, optional LLM veto
- **Outputs (simulation DB)**: `simulation_run_timeline_fit_decisions` (decisions_json + stats_json)
- **Side effects**: sets `parentId` on moments in moment graph when attached
- **LLM?**: optional (currently controlled by env `SIMULATION_TIMELINE_FIT_USE_LLM`)
  - Design intent: even when LLM is used, the call must be in **core orchestrator via ports**, not in the simulation runner.

## The enforcement problem (types alone are not enough)

Key point: **Types cannot prevent someone from importing `callLLM` inside an adapter.**

So the enforcement plan should use **two layers**:

1) **Types** to standardize and constrain the surface area (what functions are expected, and what they receive).
2) **Cursor repo rules** to constrain *agent behavior* (what goes where, and what is forbidden), plus a recurring review checklist during migration.

## Proposed “interfaces” (function types) for orchestration and adapters

### Orchestrator type (core)

Each phase core exports a single entrypoint:

- `run<PhaseId>Orchestrator({ ports, input }) -> { output, audit }`

Where:

- **`ports`** is a single object holding all I/O and external effects.
- **`input`** is pure data (no DB handles, no env).

This shape makes it mechanically obvious where I/O lives.

### Adapter type (live/simulation)

Each environment exports a single adapter entrypoint:

- `run<PhaseId>Adapter({ io, input, now, log }) -> persisted outputs`

Where:

- **`io`** is a narrow object holding DB handles + read/write functions.
- adapter reads the necessary DB rows/artifacts, calls core orchestrator, persists results.

Again: types improve clarity, but do not stop illegal imports.

### Where the shared types should live (recommendation)

Create a small shared types module used by all phases, e.g.:

- `src/app/engine/phases/_shared/contracts.ts`

It should define:

- `PhaseId` (or reuse `SimulationPhase` where appropriate)
- common `PhaseAuditEvent` / counters shapes
- the canonical function shapes for `Orchestrator` and `Adapter`
- guidance on ports naming (`load*`, `persist*`, `llm*`, `vector*`)

This gives us one place to standardize contracts and avoids re-inventing the shape per phase.

### Minimal typed contract (example shape)

- `type PhaseOrchestrator<Input, Output, Ports, Audit> = (args: { ports: Ports; input: Input }) => Promise<{ output: Output; audit: Audit }>`
- `type PhaseAdapter<AdapterInput, Persisted, Io> = (args: { io: Io; input: AdapterInput; now: string; log: { info(...); warn(...); error(...) } }) => Promise<Persisted>`

The exact types don’t matter as much as forcing every phase to fit the same conceptual mold:

- **core orchestrator** takes `{ ports, input }`
- **adapter** takes `{ io, input, now, log }`

### What to review when adding these types

When introducing the shared contracts, audit the engine code we’ve already touched:

- `src/app/engine/phases/ingest_diff/**`
- `src/app/engine/phases/micro_batches/**`
- `src/app/engine/phases/macro_synthesis/**`
- `src/app/engine/phases/macro_classification/**`
- `src/app/engine/runners/simulation/runner.ts`
- `src/app/engine/routes/simulation.ts`
- `src/app/engine/adapters/simulation/*` (registry, artifacts, progress)

Goal of this audit: confirm the phase-first split is real, not just file moves — i.e. **core owns the behavior** and **adapters are I/O**.

## Cursor rules + review discipline (the practical enforcement)

We will enforce the “core vs adapter” boundary primarily via:

- **Repo `.cursor` rules** (agent guardrails): create/update `.cursor/rules/phase-first-architecture.md`.
- **Typed entrypoints**: each phase exports a single typed orchestrator entrypoint and a single typed adapter entrypoint per environment (simulation/live).
- **Mandatory review checklist**: every migration PR/step must include a structured review of imports and responsibilities.

### Cursor rules (what to add)

Add a rules doc at:

- `.cursor/rules/phase-first-architecture.md`

It should include explicit, enforceable-by-humans statements like:

- **Phase-first layout**: all phase code lives under `src/app/engine/phases/<phase>/...`.
- **Core owns flow**: orchestration and decision-making lives in `core/orchestrator.ts` (or helpers called by it).
- **Adapters are I/O only**: adapters only read/write artifacts and translate shapes; no gating/selection logic; no LLM calls.
- **Ports injection**: core calls ports; adapters implement ports; core never imports concrete DB clients, vector indices, or LLM utilities directly.
- **No shims in final state**: after a phase is migrated and imports are updated, delete the old module(s).

### Mandatory review checklist (do this repeatedly during the migration)

Both for **already migrated code**, as well as **every time we touch engine code**, do this review:

- **File placement**: does the code live under the correct `phases/<phase>/...` directory?
- **Adapter purity**: confirm `simulation/adapter.ts` and `live/adapter.ts` contain only:
  - loading inputs/artifacts
  - calling core orchestrator
  - persisting outputs/artifacts
  - logging and error mapping
- **Core orchestration**: confirm core orchestrator contains:
  - deterministic decisions / gating
  - sequencing / control flow
  - calls to ports (LLM/vector/db/etc) *only through injected ports*
- **Imports sanity**:
  - adapter must not import `utils/llm`, `callLLM`, `utils/vector`, `subjects/*`, `plugins/*`
  - core should not import concrete simulation DB accessors; it should accept ports instead
- **Registry drift**: ensure runner/routes/UI wiring are registry-driven and don’t reintroduce scattered `if/else` per-phase branching.

This checklist is not optional; it’s the mechanism to “make damn sure” we don’t regress while migrating, and to redo migrations already done that were done wrong.

I must reiterate - **CHECK THE CODE THAT HAS ALREADY BEEN MIGRATED AS WELL**.

## Concrete remaining work (checklist)

### 1) Finish phase migrations for remaining phases

For each of:

- `materialize_moments`
- `deterministic_linking`
- `candidate_sets`
- `timeline_fit`

Do:

- create `src/app/engine/phases/<phase>/{core,live,simulation}/...`
- move orchestration to `core/orchestrator.ts`
- define ports interfaces in core
- make `simulation/adapter.ts` **I/O only**
- make `simulation/runner.ts` **thin** (phase.start/end, error handling, calling adapter)
- update runner dispatch registry to point to new runner
- update server artifact routes registry if needed
- update UI view registry if needed

### 2) Hard cutover: delete shims

After imports are updated to new phase-first locations, delete:

- `src/app/engine/core/indexing/ingest_diff_orchestrator.ts`
- `src/app/engine/core/indexing/micro_batches_orchestrator.ts`
- `src/app/engine/runners/simulation/phases/ingest_diff.ts`
- `src/app/engine/runners/simulation/phases/micro_batches.ts`
- `src/app/engine/runners/simulation/phases/macro_synthesis.ts`

And any other remaining re-export shims created during migration.

DO NOT CREATE SHIMS YOURSELF - RATHER SIMPLY `rm` the old code - WE DO NOT NEED SHIMS, THEY WILL ONLY SLOW US DONE - NONE OF THIS WILL BE MERGED HALFWAY.

### 3) Enforce the adapter/orchestrator boundary

- add/update `.cursor/rules/phase-first-architecture.md` (required)
- implement typed phase entrypoints (required): orchestrator + adapter signatures, ports injection
- apply the **mandatory review checklist** above continuously (required)
- (optional) consolidate registry to a single phase registry file co-located under `src/app/engine/phases/`

### 4) Validate invariants via simulation tests

Existing simulation tests were run successfully in this worktree (last recorded run used `MACHINEN_TEST_FORCE_DEV=1 pnpm -s test:simulation`).

After migrations and deletions, rerun:

- `MACHINEN_TEST_FORCE_DEV=1 pnpm -s test:simulation`

## “Golden rules” to keep credibility and avoid drift

- If a file is called `adapter.ts`, it should be boring: **reads + writes only**.
- If a phase needs logic, it goes in `core/orchestrator.ts` (or helpers called by it).
- LLM prompts must come from the old hardened sources; avoid inventing fallbacks.
- Always preserve the invariant: **0 micro → 0 macro**, no placeholders.
- Prefer canonical identifiers (`chunk-batch:${batchHash}:${index}`) and rich provenance everywhere.
- No shims in the final state: update imports, delete old files, keep the tree honest.

