# 2026-01-13-backfill-simulation-phases-and-linking

## Capturing the discussion

I want backfilling to be the primary way to evaluate the system, because it gives a large, repeatable dataset and does not depend on waiting for live events. Right now, it seems like the live path and the backfill path have diverged, and the backfill path has grown organically with less clear constraints.

The main pain is iteration speed and reliability:

- It can take a long time before moments even appear.
- Backfill can stall or need manual intervention.
- Making it faster tends to reduce linking quality, and the tradeoffs are not structured in a way that makes them easy to reason about.

I think we need to reintroduce rigor with explicit interfaces and constraints (plugin hooks seemed to work well early on), so that implementations can be swapped without changing the shape of the system.

## Clarifying the 'collect' vs 'replay' confusion

My current understanding is that 'collect' is mostly about producing replay items (and run accounting), not about materializing moments in the moment graph. The moments appear during the replay phase when replay items are applied. That matches the observation that collection can finish but the graph still looks empty until replay makes progress.

If that is correct, then 'phase 1 should create moments' is a real gap in the current mental model: the current phase 1 creates replay inputs, but not the outputs that make the system inspectable.

## Desired shape: phased simulation with early exits

I want backfill to look like a simulation with explicit phases, where each phase:

- consumes persisted outputs of the prior phase
- has bounded work per item
- can be restarted from that phase without recomputing everything

I think linking should be treated as progressive refinement, similar to a painter's algorithm:

- do fast, deterministic attachments first
- then do slower, higher-cost attachment checks on what remains

The point is to avoid slow cases holding up fast cases, and to avoid paying the LLM cost for cases that can be closed out deterministically.

## Clarified: prefer 'A2' (synthesis is part of the pipeline)

I think the preferred shape is:

- Phase 1 includes synthesis work (LLM) and produces persisted synthesis artifacts.
- Later phases reuse those artifacts and should not redo synthesis unless inputs changed.

This means the first phase can still be expensive on a cold run, but it becomes the primary target for caching and incremental recomputation. It also makes "moments appear" a concrete output of Phase 1, rather than something that depends on the linking phases completing.

## Proposed phases (attempt)

I want an explicit, restartable sequence. Names are placeholders.

### Phase A: ingest and diff (document-level)

Input: source documents.

Output:

- stable chunking result per document
- per-chunk hashes and a document-level change signal

Notes:

- This is where I want deterministic short-circuiting when inputs did not change.

### Phase B: micro-moment batches (cached)

Input: changed chunks.

Output:

- micro-moment batch summaries (and any per-batch embeddings that are part of synthesis)
- batch hashes so identical batches do not recompute

Notes:

- This phase should be bounded and resumable.

### Phase C: macro synthesis (cached)

Input: micro-moment stream (from cached batch outputs).

Output:

- macro-moment list per stream
- macro gating results (kept vs dropped)
- synthesis audit log (parse failures, counts, etc)

Notes:

- This is where most cold-run cost likely lives.
- On reruns, I want this to reuse cached micro-moment batches and reuse macro outputs unless the micro stream changed.

### Phase D: materialize moments (no cross-document linking)

Input: macro outputs.

Output:

- moment rows exist in the moment graph quickly
- within-document ordering and stream structure exists
- parent links are either empty or only within-stream (depending on the model)

Notes:

- This makes the system inspectable without waiting for cross-document linking.

### Phase E: deterministic linking pass (fast)

Input: moment rows + any extracted anchors.

Output:

- parent links set when deterministic evidence is sufficient
- audit trail explains which rule applied

Candidate sources of deterministic evidence (examples):

- explicit issue/pr references that map to a known document id in the namespace
- canonical reference tokens that map to known entities
- strict time ordering (never allow parent later than child)

### Phase F: candidate set computation (bounded, persisted)

Input: remaining unlinked moments.

Output:

- per-moment candidate list with evidence (vector scores, anchor matches, time metadata)
- deterministic rejects applied (namespace mismatch, time inversion, missing rows)

Notes:

- Persisting this lets me restart the expensive decision phase without redoing candidate generation.

### Phase G: timeline-fit decision (expensive, bounded)

Input: per-moment candidate lists + bounded chain context.

Output:

- attach/reject decision per candidate, plus explanation
- chosen parent link when attach

Notes:

- This phase is allowed to be slow, but it should have stable caps and telemetry.
- It should only run for the remainder after deterministic linking.

### Phase H: optional refinement passes

Examples:

- rerun Phase G with different caps or model settings
- separate pass to repair obvious time inversions by leaving them unlinked (not by inserting into chains)
- subject merge experiments (if we decide to support it)

## Questions to answer as part of the design

- What is the minimum set of phases that makes the system inspectable early (moments visible quickly) while still supporting time-ordered linking later?
- What deterministic link types can we use to attach without vector search or LLM calls?
- What intermediate artifacts should be persisted (per phase) so that we can restart from an earlier phase without recomputing moments?
- What constraints should be encoded in interfaces so changes do not silently break invariants (namespace scoping, chronological parent ordering, idempotency)?
- What end-to-end test shape can validate 'the system still works' without hardcoding expectations about every specific link decision?

## Interfaces and invariants (what I want to be strict about)

I want the system shape to be stable even as implementations change.

### Persisted artifacts per phase

- document diff outputs (chunk ids/hashes, change flags)
- micro batch outputs (batch hash -> summary payload)
- macro outputs (stream -> list of macro moments + gating metadata)
- moment materialization outputs (moment rows with stable ids and timestamps)
- deterministic link decisions (rule id, evidence, chosen parent)
- candidate lists (per moment, bounded, with evidence)
- timeline-fit decisions (per candidate, bounded context inputs, outcome)
- per-run telemetry (cursor, last progress timestamp, last item info, error states)

### Invariants I want enforced

- idempotency: rerunning a phase with the same inputs should not change outputs
- chronological ordering: a parent is never later than a child; never create cycles
- namespace and prefix scoping: all reads/writes resolve against the same effective namespace
- bounded work: caps on candidate counts, context sizes, per-item retries
- explainability: every attach/reject has a recorded reason path (deterministic vs model)

## Test shape (constraint-oriented, not link-by-link)

I do not want to assert every parent link. I want tests that detect shape breakage.

- run a small fixed corpus through phases A-G
- assert invariants:
  - no time inversion links
  - no cycles (or at least detect them)
  - moment counts stay within expected ranges
  - candidate list sizes respect caps
  - the run reaches a completed or paused state, not a silent stall
- assert a small set of deterministic anchor outcomes (example: explicit closes links attach)
- record budgets:
  - count of model calls per phase
  - time spent per phase
  - cache hit rates for micro/macro outputs

## Decision (for now): keep anchor extraction tied to Phase C

Anchor extraction could be its own deterministic phase between materialization and linking, but for now I want to keep it bundled with macro synthesis outputs in Phase C. This keeps the phase graph simpler while the bigger backfill/simulation shape is still in flux.

## How enforcing invariants looks in practice (attempt)

I want the invariants to be enforced by a mix of:

- write-time guards (refuse invalid writes)
- persisted keys (make recomputation and idempotency explicit)
- phase-level validation (detect mismatches early and record them)
- tests that check constraints instead of asserting every link

### Idempotency

What I want:

- Each phase output is keyed by a stable input identity (document id + document hash, batch hash, micro stream hash, etc).
- Writes are upserts keyed on that identity, not append-only.
- Rerunning a phase with the same inputs should hit stored outputs and avoid recomputation.

How it is enforced:

- Persist the identity alongside outputs.
- On phase start, check for an existing output with the same identity and reuse it.
- If an output exists but does not match what the phase would produce, record a mismatch event and choose one behavior (recompute and overwrite, or fail fast).

How it is tested:

- Run A-G twice with no input changes and assert output counts/fingerprints do not change.
- Track cache hit rates per phase and alert when hits drop unexpectedly.

### Chronological ordering and no cycles

What I want:

- Parent time is never later than child time.
- Links never create cycles.

How it is enforced:

- Before writing a parent link, validate parent_time <= child_time and parent_id != child_id.
- Before writing, check that the proposed parent is not already a descendant of the child (bounded ancestry walk or an ancestry query).
- On failure, leave the moment unlinked and record a deterministic reject reason.

How it is tested:

- Scan all stored links for time inversions.
- Run a cycle detector over the stored graph (bounded per node).

### Namespace and prefix scoping

What I want:

- Every read/write in a run is scoped to the same effective namespace (base namespace + prefix).
- Links never cross namespaces.

How it is enforced:

- Resolve effective namespace once per phase invocation and pass it through explicitly.
- Always include namespace in storage keys / query filters and maintain indexes so queries do not rely on post-filtering.
- When linking, require parent and child to share the same effective namespace (deterministic reject otherwise).

How it is tested:

- Run the same corpus into two namespaces and assert no cross-namespace links.
- Assert vector queries and DB queries return only the scoped namespace (not 'fetch-all then drop').

### Bounded work

What I want:

- Stable caps on per-item work so slow cases do not block the entire run.

How it is enforced:

- Hard caps on candidate list sizes, chain context sizes, and retries.
- Persist candidate lists so Phase G consumes only the bounded list produced by Phase F.
- Backoff and pause on repeated failures rather than tight retry loops.

How it is tested:

- Assert candidate list sizes do not exceed caps.
- Record per-phase budgets (model calls, vector queries, time spent) and compare against baselines for regressions.

### Explainability

What I want:

- Every attach/reject has a recorded reason and inputs, so unexpected behavior can be inspected without reproducing runs.

How it is enforced:

- Deterministic linking writes a decision record including the rule id and evidence.
- Timeline-fit writes per-candidate decision records including the bounded context inputs and the outcome.
- Run telemetry records phase start/end, batch completion, item failures, and pause reasons.

How it is tested:

- For sampled moments, assert a decision record exists and references the inputs that were used.

## Iterative implementation plan (start with skeleton, then phase-by-phase)

I want to implement this by first creating a runner skeleton that can represent phases and persist run state, then filling in phase behavior one phase at a time. Each phase should have a small validation checklist that proves it is doing what it claims.

### Step 1: runner skeleton (phases stubbed)

Shape:

- define the phase list (A-G or A-H) as an explicit ordered set
- define a per-run state record that includes:
  - current phase cursor
  - status (running, paused_on_error, paused_manual, completed)
  - last progress timestamp and last item metadata
  - per-phase events (start/end + counts)
- implement a way to start a run, advance to the next phase, and resume from a phase boundary

Validation:

- a run can be created and progresses through the phase list deterministically (even if phases are no-ops)
- restart/resume at a phase boundary is possible without corrupting run state
- phase transitions and stop reasons are visible in stored run telemetry

### Step 2: implement Phase A (ingest + diff) and validate

Validation:

- the phase records a stable document identity and change signal (unchanged vs changed)
- rerun with unchanged inputs produces no downstream work (diff short-circuits)
- phase writes are idempotent (no duplicate per-document state)

### Step 3: implement Phase B (micro batch caching) and validate

Validation:

- batch identities exist and are stable
- rerun uses cached batch outputs when identities match
- batch sizes are bounded (no unbounded per-item inputs)

### Step 4: implement Phase C (macro synthesis caching + anchors) and validate

Validation:

- macro outputs exist per stream, along with gating metadata and audit events
- rerun reuses macro outputs when micro stream identity is unchanged
- anchors exist as part of macro outputs (for now, bundled with Phase C)

### Step 5: implement Phase D (materialize moments, no cross-document linking) and validate

Validation:

- moment rows exist and are visible without running cross-document linking
- moment ids and timestamps are stable on rerun
- parent links are empty (or within-stream only) by construction

### Step 6: implement Phase E (deterministic linking) and validate

Validation:

- deterministic anchor cases attach consistently
- time ordering guard is enforced (reject with recorded reason rather than writing an invalid link)
- each attach/reject records a decision event with evidence

### Step 7: implement Phase F (persist candidate lists) and validate

Validation:

- candidate lists are persisted per moment and capped
- rerunning the decision phase does not require regenerating candidate lists
- deterministic reject reasons are recorded (namespace mismatch, time inversion, missing rows)

### Step 8: implement Phase G (timeline-fit) and validate

Validation:

- per-candidate attach/reject decisions are recorded with bounded context inputs
- repeated failures pause the run with a recorded failing item (no silent stalls)
- budgets are visible (counts, time spent) so regressions show up quickly

## Arch notes location

I want long-lived architecture docs to stay under `docs/architecture/`. For working/iterating architecture notes, I want to store them under `.notes/justin/arch-notes/` with dated filenames (YYYY-MM-DD-...).

Moved from `docs/architecture/` into `.notes/justin/arch-notes/`:

- 2026-01-13-timeline-fit-as-linking-plugin.md
- 2026-01-13-moment-replay-run-semantics.md
- 2026-01-13-namespace-aware-backfill-and-resync.md

## Step 1 kickoff: fresh DB for phase runner skeleton

I want the phase runner skeleton to start with a fresh DB and a separate Durable Object binding, rather than reusing the existing replay tables in indexing state. The goal is to avoid inheriting replay-specific shape and to make the phase runner state model explicit from day one.

Progress:

- Added a simulation state Durable Object with its own migrations.
- Added admin endpoints to start a simulation run, advance phases (no-op), and inspect run state and events.
- Added pause/resume and restart-from-phase controls so we can validate phase-boundary semantics before implementing phase behavior.

Acceptance check (local dev server):

- Started `pnpm dev` (Vite on localhost:5173).
- Created a simulation run via `/admin/simulation/run/start`.
- Advanced phase once (A -> B).
- Paused the run and confirmed advancing while paused does not change phase.
- Resumed the run and advanced again (B -> C).
- Restarted from phase A and confirmed run state reset to A.
- Fetched events and confirmed it recorded phase start/end and pause/resume/restart events.

Added a contract test for this:

- `tests/simulation-runner.contract.test.mjs` (node:test + fetch)
- `pnpm test:contract` runs it against a running dev server using MACHINEN_BASE_URL and MACHINEN_API_KEY env vars.

Next:

- Add a helper script that starts `pnpm dev` (if needed), waits for the local port, runs `pnpm test:contract`, then shuts `pnpm dev` down when done.

Follow-up:

- I switched `test:contract` to run the helper script. The helper script originally invoked `pnpm test:contract`, which caused it to call itself recursively. Fixed by calling `pnpm test:contract:raw` from the helper script.

## Phase A (ingest + diff) first cut

I implemented a first cut of Phase A in the simulation runner:

- Migration adds `simulation_run_documents` keyed by (run_id, r2_key).
- Advancing a run while in phase A reads each configured r2Key from R2 (head), compares the current etag against the stored etag for the same (run_id, r2_key), and writes changed=0/1.
- If any head/read fails, the run is set to paused_on_error with last_error_json populated.

I also added an endpoint to inspect the per-run document rows:

- GET `/admin/simulation/run/:runId/documents`

And a Phase A acceptance test that runs against a dev server when an explicit key is provided:

- `pnpm test:phase-a` (requires MACHINEN_TEST_R2_KEY; otherwise skips)

I ran `pnpm test:all` with MACHINEN_TEST_R2_KEY set to a real key (github/redwoodjs/sdk/issues/552/latest.json). Contract + Phase A both passed.

## Phase B (micro_batches) first cut

I implemented a first cut of micro batch caching as the `micro_batches` phase:

- Migration adds `simulation_run_micro_batches` (per-run mapping) and `simulation_micro_batch_cache` (global cache keyed by batch_hash + prompt_context_hash).
- Advancing a run in `micro_batches` prepares the document via plugins, splits into chunks, groups chunks into bounded batches, computes a batch hash from chunk ids + content hashes, and writes per-run batch rows.
- If a cache entry exists for the batch key, it marks the run batch row as cached.
- If no cache entry exists, it writes a cache entry using a deterministic fallback summarization by default.
- LLM summarization is behind `SIMULATION_MICRO_BATCH_USE_LLM=1` so tests can run without AI calls.
- Added an endpoint to inspect per-run batches: GET `/admin/simulation/run/:runId/micro-batches` (optional r2Key query param).

I added a suite test `tests/simulation/micro_batches.test.mjs` that verifies the cache reuse behavior without LLM.

## Planned steps

#### Step 1 - Write the structure (no real behavior yet)
- **Deliverable**: a short architecture note that defines:
   - phases (semantic ids) and their inputs/outputs
  - persisted artifact keys (what identifies “same inputs”)
  - run state model (phase cursor, statuses, restart semantics)
  - invariants + what each phase must log/record
- **Validation**: everyone can point at one place and agree “this is what a run is” (we mostly have this in the work log already, so this is mostly packaging + clarifying run-state semantics).

#### Step 2 - Implement the runner skeleton (phases stubbed)
- **Behavior**: can create a run, advance phase cursor, record per-phase start/end and basic telemetry, but phases can be placeholders.
- **Validation**:
  - run progresses deterministically through phases (even if phases do nothing)
  - run can be resumed/restarted at a phase boundary
  - logs show phase transitions and reasons for stopping

 #### Step 3 - Implement ingest_diff, then validate (done)
 - **ingest_diff validation**:
  - deterministic diff identity recorded
  - rerun with unchanged inputs yields “no changes” and does not enqueue downstream work

 #### Step 4 - Implement micro_batches, then validate (done)
 - **micro_batches validation**:
  - batch hashes exist
  - rerun hits cache (batch recompute count near zero)
  - bounded batch sizes

 #### Step 4.5 - Update audit UI to drive and inspect simulation runs
 - **UI**:
   - list recent simulation runs and show status/current phase
   - show run events in a copyable format
   - controls: start/advance/pause/resume/restart
   - drilldowns for per-run artifacts already available: documents and micro batches
 - **Validation**:
   - I can run ingest_diff and micro_batches end-to-end from the UI and inspect their stored artifacts without using curl

 #### Step 5 - Implement macro_synthesis, then validate
 - **macro_synthesis validation**:
  - macro outputs + gating + audit logs exist for each doc/stream
  - rerun does not redo macro work if micro stream identity unchanged
  - anchors (since we’re bundling) are present in macro outputs

 #### Step 6 - Implement materialize_moments (“moments exist”), then validate
 - **materialize_moments validation**:
  - moments visible without cross-doc linking
  - stable ids + timestamps
  - rerun is idempotent (no duplicates)

 #### Step 7 - Implement deterministic_linking, then validate
 - **deterministic_linking validation**:
  - deterministic rules attach expected anchor cases
  - time-order guard enforced (reject with reason)
  - decision records written

 #### Step 8 - Implement candidate_sets then timeline_fit, validate each
 - **candidate_sets validation**: candidate lists persisted and capped
 - **timeline_fit validation**: attach/reject decisions persisted; pause-on-error vs stall

## Requirement: run-scoped audit logging (persist + UI)

I want each simulation run to have a run-scoped audit log (like CI logs) that is:

- persisted in the simulation state DB
- surfaced in the UI
- especially useful for failures (error payloads, last known item, where it failed)

This should be a default part of the system, not optional debugging.

Implementation direction:

- Any place we log to console in the simulation runner should also write a structured event into the run audit log.
- Add a small utility that can write to both sinks (console + run events) so call sites stay consistent.
- For volume control:
  - always persist warn/error
  - persist info/debug only when enabled (env flag or per-run config)

## Starting UI + run audit logging step

Next change is to make simulation runs observable and debuggable without using curl or tailing worker logs.

I want:

- a UI view of runs (list + detail)
- a persisted per-run audit log that is usable when runs pause or fail

Before writing code, I wrote an arch-note that describes the UI surfaces and the shape of persisted run events.

## Implementing audit UI for simulation runs

I’m adding a small audit UI page under `/audit` that:

- lists recent simulation runs
- shows a run detail view with run status/current phase + the persisted run events stream
- provides run controls (start/advance/pause/resume/restart)
- links to existing artifact drilldowns (documents, micro batches)

I’m also adding a lightweight UI smoke test using Playwright as a plain library from `node:test` (no Playwright test runner), so we get basic clicking + DOM checks without adding a separate harness.

## Making the UI smoke test runnable

I added Playwright as a dev dependency and a small install script that downloads Chromium, so the `node:test` UI smoke can run locally.

While running the test, the dev server showed a Vite error overlay caused by the rwsdk HMR directive-scan trying to read files that had been deleted earlier. The overlay blocks Playwright clicks. I added empty stub modules at the deleted paths so the dev server no longer throws ENOENT and the UI smoke test can proceed.

I ran:

- `pnpm -s playwright:install`
- `pnpm -s test:simulation:ui`
- `pnpm -s test:simulation`

## Implemented macro_synthesis phase

I added a macro_synthesis phase that consumes micro batch results and persists per-run macro outputs for each document.

Notes:

- I reused the existing engine macro synthesis helper that can split micro moments into streams, but I kept LLM usage off by default. When `SIMULATION_MACRO_USE_LLM=1` is set, macro synthesis uses the LLM-based stream synthesis.
- A per-document micro stream identity is computed from ordered (batch_hash, prompt_context_hash) pairs. When the identity matches a previously stored value for that run+document, macro_synthesis short-circuits and reuses the existing outputs.
- Outputs are stored in a simulation DB table keyed by (run_id, r2_key), and include streams, a gating summary, an anchor token list, and optional synthesis audit events.
- I added a macro outputs endpoint and surfaced it in the audit UI under the simulation run page.

I added a phase test that runs ingest_diff -> micro_batches -> macro_synthesis, verifies the output exists, restarts from macro_synthesis, and verifies the micro stream identity is stable.

## Starting materialize_moments phase

Next is materialize_moments: write macro synthesis outputs into the moment graph as actual moment rows (no cross-document linking yet).

Checks I want:

- moments exist and are visible without linking
- ids are stable (rerun does not create duplicates)
- timestamps are preserved from the macro output data

## Implemented materialize_moments phase

I implemented materialize_moments to insert macro outputs into the moment graph as moment rows without cross-document linking.

Notes:

- Moment ids are stable: derived from (run id, effective namespace, document id, stream id, macro index).
- I hit a unique constraint from the moment DB schema (unique per document micro_paths_hash) when reusing the default namespace across multiple runs. The fix is to default simulation runs to a per-run moment graph namespace (`sim-<runId>`) when no namespace is provided.
- I added a simulation DB mapping table so the run can be inspected without querying the moment DB directly.

I added:

- `GET /admin/simulation/run/:runId/materialized-moments`
- an audit UI drilldown for “Materialized moments”
- a phase test that checks moments exist, parents are null, and reruns are idempotent.

## Refactor: split simulationDb/index.ts

The simulation state code is now large enough that it’s hard to navigate and hard to see phase boundaries and shared utilities.

Next change is a mechanical refactor:

- split the simulation DB code into separate modules (runs/events/phases/utils/db)
- keep the public exports stable so routes, UI, and tests don’t need a large diff
- avoid behavior changes while doing the split

After the split, I reran the simulation test suite to check that behavior stayed the same.

I’m doing another mechanical refactor: move only the simulation-related additions out of the engine routes and engine module into smaller files, then import them back in place. The goal is to keep the non-simulation code unchanged and keep behavior stable.

## Next attempt: finish simulation linking phases before unifying live and simulation pipelines

I want to finish the remaining simulation phases (deterministic_linking, candidate_sets, timeline_fit) before trying to unify the live indexing path and the simulation runner.

The duplication concern is mostly about control-flow and caching semantics drifting between live and simulation. Sharing helpers reduces some drift, but it still leaves two separate pipelines that can diverge in what they consider "changed", what they cache, and how they handle errors.

The direction I want to try after phases E-G exist:

- Split each phase into a "phase core" (pure-ish computation that returns outputs + structured events) and a "phase storage adapter" (reads prior outputs, writes next outputs).
- Simulation runner becomes (storage adapter + phase core) with persisted artifacts and restart semantics.
- Live indexing can invoke the same phase cores for a single document/event using a minimal adapter (in-memory where possible, moment DB writes where required).

For now, I want the simulation phases to use the existing plugin surface (proposeMacroMomentParent and the timeline-fit linker) and persist artifacts so phase boundaries are restartable and inspectable in the audit UI.

Decision: core-authoritative identities

For the later unification work (phase core + storage adapters), I want the phase core to define the input identity for reuse. The adapters can store that identity (or not), but they should not invent a different definition of "same inputs".

This likely means live indexing will sometimes recompute identities and intermediate values that it could otherwise skip. I think that is acceptable while converging the two pipelines, because it reduces drift where live and simulation disagree about whether a document changed or whether an output can be reused.

## Starting deterministic_linking (Step 7)

The next planned step is deterministic_linking. This needs persisted artifacts (decisions, rejects, and chosen parent ids) so it can be restarted and inspected in the audit UI, similar to how micro batch and macro outputs are persisted.

I’m going to start by adding migrations and a phase executor wired into the runner, then implement a small set of deterministic rules with validation checks (idempotency, time ordering, and no cycles).

## Starting Step 8 (candidate_sets + timeline_fit)

Next is candidate_sets and timeline_fit. I want these to be restartable and inspectable like the earlier phases, so they need persisted artifacts:

- candidate_sets persists a bounded list of candidate parents (plus reject reasons)
- timeline_fit persists per-candidate decisions and the chosen parent (if any)

I’m going to implement these phases end-to-end (migrations, executors, admin endpoints, audit UI drilldowns, and tests).

## Next refactor attempt: phase cores + storage adapters (live + simulation convergence)

Now that phases A-G exist in simulation (with persisted artifacts and UI drilldowns), the next step is to converge live indexing and simulation onto the same phase logic so control-flow and caching semantics don’t drift.

The shape I want to try:

- Each phase becomes two layers:
  - phase core: pure-ish computation that consumes in-memory inputs and returns outputs + structured events
  - storage adapter: reads prior artifacts and writes outputs (simulation persists; live uses minimal persistence)

Decision: core-authoritative identities

- The phase core defines what "same inputs" means for reuse (the identity/fingerprint).
- Adapters can store/read identities, but they should not invent a different definition.

### Scope

Start by converging phases A-D, then extend to E-G:

- A-D are already largely per-document transforms.
- E-G depend on cross-document reads, so they likely need slightly different adapters but can still share core logic for ranking/filtering and decision recording.

### Proposed responsibilities

Phase core:

- computes input identity
- computes outputs and structured events
- does not directly read/write simulation tables

Simulation adapter:

- reads inputs from simulation tables
- writes outputs to simulation tables
- writes run-scoped events
- advances run phase cursor

Live adapter:

- reads inputs from the live path (plugins + current stored moment graph state)
- writes only what live already writes (moments, existing state like processed chunk hashes, document audit logs)
- can keep intermediate values in memory for a single document/event

### Rollout order (attempt)

1. Extract phase A core: document prepare + chunk split + diff identity computation.
   - Keep simulation ingest_diff behavior unchanged for now, but define a shared identity primitive to converge on later.
2. Extract phase B core: chunk batching + micro prompt context + micro batch identity.
3. Extract phase C core: micro stream identity + macro synthesis invocation + anchor extraction.
4. Extract phase D core: deterministic moment id derivation + moment row upsert inputs.
5. Extract phase E core: within-stream chaining + deterministic cross-doc attach rule evaluation (and structured decision outputs).
6. Extract phase F core: candidate filtering + cap enforcement (inputs are vector matches + moment rows).
7. Extract phase G core: decision application with bounded context (initially keep "choose top candidate" behavior, later adapt timeline-fit linker logic).

### Validation

- Simulation tests remain green (phase outputs and artifacts should remain stable).
- Live indexing should still produce moments and links; for now it can recompute identities more often than before.
- Run-scoped audit logging remains available for simulation runs.

Reminder: provenance alignment

When extracting phase cores and introducing live/simulation adapters, I want to keep provenance consistent with the live path.

In particular, I want to verify:

- what provenance fields are written into moment rows today (source metadata, document identifiers, time range metadata, link audit log payloads)
- whether simulation writes the same fields in the same shape, or whether it diverges (especially in materialize_moments and the linking phases)
- that the phase cores do not accidentally drop provenance, since the adapters will be reshuffling where data is computed vs persisted

## Starting phase cores + adapters refactor

I wrote `docs/architecture/phase-cores-and-adapters.md` to capture the refactor shape (phase cores + storage adapters, core-authoritative identities, and provenance checks).

## Steps plan (core extraction + adapters)

This is the concrete rollout I want to follow. The goal is to keep each step small, keep tests green, and avoid reintroducing large modules.

### Step 0 - Provenance snapshot (before moving logic)

- Identify the provenance fields written by the live path into:
  - moment rows (document id, createdAt, author, micro paths, source metadata)
  - link audit logs
  - time range metadata used by time ordering guards
- Compare with what simulation writes today for the same moments and links.
- Decide what must be aligned as part of extraction (rather than leaving it as a later follow-up).

### Step 1 - Create phase core modules (B/C/D first)

Add a shared directory with separate files per phase core (no monolithic pipeline file).

- Phase B core:
  - inputs: chunks + prompt context + env caps
  - identity: batch_hash + prompt_context_hash
  - outputs: micro items (and any metadata needed downstream)
- Phase C core:
  - inputs: ordered micro batch outputs
  - identity: micro stream hash
  - outputs: streams, anchors, audit events, gating summary
- Phase D core:
  - inputs: macro outputs + document identity + namespace
  - identity: deterministic moment ids derived from stable inputs
  - outputs: moment write inputs (including provenance payloads)

### Step 2 - Simulation phases call cores (behavior should remain stable)

For each of B/C/D:

- simulation adapter reads persisted inputs
- calls core
- persists outputs using existing tables
- records run events as before

### Step 3 - Live adapter invokes the same cores (B/C/D)

Introduce a minimal live adapter that:

- prepares inputs using existing live hooks (plugins + current stored state)
- calls the same B/C/D cores
- writes only what live already writes (moments, existing state, document audit logs)

### Step 4 - Converge identities for A

After B/C/D are shared, extract identity primitives needed to converge A:

- define a shared document identity for change detection
- keep simulation’s current ingest_diff behavior stable initially, but introduce the shared identity so both paths can migrate towards the same meaning of “changed”

### Step 5 - Linking phases (E-G)

Once B/C/D are shared and provenance is aligned:

- extract E core (within-stream chaining + deterministic root attach rules) so live and simulation write comparable link audit logs
- extract F core (candidate filtering + caps) so candidate sets are computed the same way
- extract G core later (timeline-fit decision). Keep “choose top candidate” behavior initially, then adapt timeline-fit linker logic into the core.

### Step 6 - Validation gates per step

- Keep `pnpm -s test:simulation` green.
- Add small targeted checks around identities (batch hash, micro stream hash, deterministic moment ids).
- Use the audit UI drilldowns to compare provenance payloads between live and simulation for a sample run.

## Step 2 (start): refactor simulation B/C/D into explicit adapters calling phase cores

I want the simulation phase executors to read like adapters:

- phase cores hold shared logic (identities and derivations)
- simulation adapters handle DB reads/writes and per-item loops
- phase executors do orchestration (phase start/end events, status transitions)

## Step 3 (start): wire live indexing to call phase cores (B first)

Next is to make the live indexing path invoke the same phase core logic, starting with Phase B planning (batch identity + prompt context).

The intent is to reduce drift without changing live output shape. I’m starting by swapping the duplicated batch hashing and micro prompt context selection logic in the live path to call the Phase B core via a small live adapter module.

Moved one other helper out of simulationDb while doing this: anchor token extraction for macro synthesis now lives under engine utils, and the sim macro synthesis adapter imports it from there. This keeps the simulationDb tree focused on simulation DB concerns.

Test harness tweak: when forcing a dedicated dev server for tests, the harness now picks a free port instead of hardcoding 5174. This avoids occasional failures when that port is already taken.

Moved the remaining generic helpers out of simulationDb phaseUtils (hashing, chunk batching, plugin pipeline, non-LLM fallback micro items). Simulation adapters now import these from engine indexing/utils modules and the simulationDb phaseUtils file is gone.

Continued Step 3:

- Phase C: live indexing now computes micro stream hash + anchors using the phase core helpers, and stores them in a document audit log entry.
- Phase D: phase core now has a tagged materialized moment identity helper. Live indexing can optionally use deterministic moment IDs via MACHINEN_LIVE_DETERMINISTIC_MOMENT_IDS=1, while still reusing existing IDs when a moment already exists.

Flipped the default for live deterministic moment ids: removed the env flag gate and always derive ids for newly created macro moments, while still preferring an existing id when a moment is found by micro paths hash.

Step 4: converged the Phase A 'changed' meaning on etag comparisons via a shared helper.

- Added a shared isDocumentChangedByEtag helper outside simulationDb.
- Simulation ingest_diff and the live scanner now both call the same helper when deciding whether a key is changed.

Step 5 (start): extract Phase E core (deterministic_linking) so simulation and live can share the same deterministic linking logic.

The current simulation deterministic_linking phase is already working end-to-end, but the logic is embedded in the simulation phase executor.

Next attempt:

- define a Phase E core module that takes in-memory moment/linking inputs and returns deterministic link decisions plus structured events
- keep all simulation DB reads/writes in a simulation adapter
- later, invoke the same core from live indexing when deciding how to attach root moments, so decision payload shapes converge

Constraints I want to keep:

- no cross-namespace links
- no time inversion (parent must not be later than child)
- avoid cycles
- keep decisions and their evidence payloads stable enough to compare between live and simulation (provenance alignment)

Implemented the first slice of this:

- added a Phase E core helper that computes deterministic parent proposals and decision evidence
- refactored the simulation deterministic_linking phase to call the core while keeping DB and moment graph writes in the simulation layer

Continued Step 5:

- added a Phase F core helper that filters and caps candidate matches into a persisted candidate list
- refactored the simulation candidate_sets phase to call the core while keeping vector retrieval and DB writes in the simulation layer

Continued Step 5:

- added a Phase G core helper that chooses a parent proposal from a persisted candidate set and produces an audit decision list
- refactored the simulation timeline_fit phase to call the core while keeping moment graph writes and decision persistence in the simulation layer

Started wiring the same Phase E/F/G cores into the live path for audit payload alignment:

- live now writes a deterministic_linking link audit payload for within-stream chaining (macroIndex > 0) using the Phase E core
- the timeline-fit linker plugin now computes and attaches Phase F and Phase G core outputs to its audit log so the payload shape can be compared against simulation artifacts

Removed the replay fast attach top1 path from the timeline-fit linker so replay always uses the deeper ranking/veto code path.

Updated simulation timeline_fit to use a Phase G core that does deeper ranking based on shared anchor tokens (and supports optional LLM veto behind an env flag).

Decision on explicit references (issue/PR refs):

The desired behavior for an explicit reference is to attach to the referenced thread head as-of the child moment time, so timelines read like:

- issue created
- cursor work / other related moments attached under the issue
- PR created referencing the issue (attaches to the latest eligible moment already in the issue thread)

Implementation changes:

- Added a shared resolver that finds the referenced document's anchor moment in the current namespace, scans its descendant thread, and picks the latest eligible node (time <= child).
- Simulation deterministic_linking now uses this resolver instead of attaching to a run-scoped document root moment id.
- Removed the explicit-issue-ref shortcut attach from the live timeline-fit plugin so Phase G remains the deep check stage.

Decision: stop preserving live linking implementation during convergence

I expected the core+adapter model to mean:

- simulation defines phase behavior (phase cores)
- simulation keeps restartable artifacts via simulation adapters
- live is just adapters for retrieval and writes

That implies we should not keep separate live behavior embedded in plugins while we are converging. If a behavior is intended to exist (explicit ref attach, candidate filtering, ranking, LLM veto), it should live in the phase core and be invoked by both simulation and live adapters.

Next step: remove the live timeline-fit linker plugin

To reduce drift, remove `smart-linker`/timeline-fit plugin code from the live path and implement live linking as adapters that call the shared Phase E/F/G cores. The live adapters load inputs and apply outputs (writes + audit payload), and the simulation adapters continue to persist restartable artifacts.

Noticed a mismatch in what 'core' means

We have been treating 'core' as pure-ish computation helpers, and 'adapters' as orchestrators that do I/O and call those helpers. That shares computation, but it still means phase behavior can live in live code and drift from simulation.

The intended shape is inverted:

- shared phase implementation orchestrates end-to-end behavior
- it calls injected ports for retrieval, model calls, and writes
- live and simulation provide port implementations

Arch-note: `.notes/justin/arch-notes/2026-01-14-invert-core-adapter-direction.md`

Progress: moved E/F/G orchestration into shared linking modules

Created shared linking orchestrators for:

- deterministic_linking (explicit ref resolution + proposal shaping)
- candidate_sets (embedding + vector query + candidate filtering/capping)
- timeline_fit (deep ranking + optional LLM veto)

Rewired both:

- live root moment parent selection
- simulation phases E/F/G

So live/simulation files now mostly wire ports and persist artifacts, and the phase control flow is shared.

Rename: stop using phase letters in module names and port fields

Phase-letter naming (A/B/C or E/F/G) was leaking ordering assumptions into filenames and APIs.

Renamed linking modules and port fields to use semantic names:

- deterministic_linking
- candidate_sets
- timeline_fit

Plan: restructure engine code into runners, adapters, core, and lib

The current layout mixes:

- live runner code
- simulation runner code
- shared phase orchestration
- small pure-ish helpers

This makes it hard to see symmetry between live and simulation, and it makes it easy for adapter implementations to grow phase logic.

Target layout (under `src/app/engine/`):

- runners/
  - live/ (document indexing runner)
  - simulation/ (simulation run runner + phase driver)
- adapters/
  - live/ (ports implementations: vector search, llm veto, moment reads/writes)
  - simulation/ (ports implementations + simulation artifact persistence)
- core/
  - linking/ (deterministic_linking, candidate_sets, timeline_fit, root_macro_moment_linking)
  - (later) micro_batches, macro_synthesis, materialize_moments orchestrators
- lib/
  - (rename current `phaseCores/` to this or split further into smaller libs)

Mapping from current modules:

- `engine.ts` and related live execution helpers -> `runners/live/*`
- `simulationDb/runner.ts` + `simulationDb/phases/*` -> `runners/simulation/*` (phase driver stays here)
- `linking/*_orchestrator.ts` + `root_macro_moment_linking.ts` -> `core/linking/*`
- `liveAdapters/*` -> `adapters/live/*` (these become only port wiring)
- `simulationDb/phases/*` port wiring + artifact writes -> `adapters/simulation/*` where possible (phases become mostly: enumerate items + call core + persist)
- `phaseCores/*` -> `lib/*` (keep as helper modules invoked by core orchestrators)

Task list (ordered):

1. Create `runners/`, `adapters/`, `core/`, `lib/` directories under `src/app/engine/`.
2. Move `linking/` orchestrators to `core/linking/` and update imports.
3. Move live port wiring (`liveAdapters/indexDocument_linking.ts`, `indexDocument_micro_batches.ts`, `indexDocument_macro_synthesis.ts`) to `adapters/live/` and rename to semantic names.
4. Split live runner `engine.ts` so its runner entrypoint imports the live adapter ports from `adapters/live/` and the core orchestrators from `core/`.
5. For simulation linking phases, move the port wiring portions into `adapters/simulation/linking/*` and keep the phase driver in `runners/simulation/` calling the shared core via those ports.
6. Rename `phaseCores/` to `lib/phaseCores/` (or `lib/` directly) and update imports.
7. Run `test:simulation` after each major move (at least after steps 2, 4, 6).

After the directory move is stable, repeat the same pattern for B/C/D so live orchestration is not in adapter files.

Progress: moved shared linking and helper libs into core/lib directories

- moved shared linking modules into `src/app/engine/core/linking/`
- moved helper phase core modules into `src/app/engine/lib/phaseCores/`
- updated imports and deleted the old directories

Progress: moved live adapters into adapters/live

- moved live adapter modules into `src/app/engine/adapters/live/`
- updated the live runner imports

Progress: introduced runners/live entrypoint

- added `src/app/engine/runners/live/` and routed engine exports through it

Scope note: directory moves for consistency

For the remaining engine code that we are not actively changing, prefer directory moves and import rewrites to match the runners/adapters/core/lib structure. Avoid changing behavior unless needed for build correctness.

Plan: consolidate engine DB modules under a databases directory

The engine directory still has DB-shaped modules at the top level:

- db (indexing state durable object)
- momentDb (moment graph durable object + queries)
- subjectDb (subject durable object + queries)
- cursorDb (cursor exchange cache queries)
- adapters/simulation/db (simulation run state durable object + access)

This makes it harder to see which files are storage adapters vs runners/core logic.

Proposed directory layout (under src/app/engine):

- databases/
  - indexingState/ (was db/)
  - momentGraph/ (was momentDb/)
  - subjects/ (was subjectDb/)
  - cursorExchangeCache/ (was cursorDb/)
  - simulationState/ (thin module that exports the simulation DO db factory + migrations, or re-exports from adapters/simulation)

Mapping and rename goals:

- Rename the generic db directory to indexingState (it holds the live indexing state DO tables and helpers).
- Keep moment graph storage named momentGraph (it holds the moment tables and queries; it is not the same as simulation run state).
- Keep subject storage named subjects (subject tables and helpers).
- Cursor cache stays cursorExchangeCache (it is a cache table for cursor conversations).
- For simulation state, decide whether to:
  - move the DO db factory and migrations into databases/simulationState and have adapters/simulation import it, or
  - keep adapters/simulation owning the DO db factory and add databases/simulationState as a re-export for consistency.

Implementation approach (to keep behavior unchanged):

- Move directories and files only, update imports, and keep exported function names the same.
- Add temporary re-export shims at the old paths (db, momentDb, subjectDb, cursorDb) to reduce churn. Delete shims once downstream imports are updated.
- After the move, run pnpm build and MACHINEN_TEST_FORCE_DEV=1 pnpm test:simulation.

Pause: this is a wide refactor (lots of import rewrites). Stop for approval before starting the directory moves.

Execution: start database directory consolidation

Proceeding with the plan to move the engine DB directories under an engine databases directory, and then rewrite imports. Keeping changes to moves/imports only, and using build + simulation tests as the check.

Progress: moved engine DB directories under engine/databases

- db -> databases/indexingState
- momentDb -> databases/momentGraph
- subjectDb -> databases/subjects
- cursorDb -> databases/cursorExchangeCache

Progress: updated imports to the moved database modules

- updated engine internal imports (engine.ts, routes.ts)
- updated worker durable object exports
- updated audit pages and gh routes that referenced momentDb or db/momentReplay
- updated simulation adapter db to reference momentGraph migrations at the moved path

Checks

- pnpm build passes after rewriting remaining internal imports (services, live adapter linking, simulation phase imports)
- MACHINEN_TEST_FORCE_DEV=1 pnpm test:simulation passes

Clarify: provenance vs payload-shape alignment

When I say provenance here, I mean moment metadata that ties a moment back to the source document and origin (issue/PR/discord thread/cursor exchange), so a moment row can be traced back without reconstructing context from logs.

Separately, there is payload-shape alignment between live and simulation (link audit payload structures, decision inputs/outputs). That is related, but it is not the same thing, and it should not be called provenance.

Practical gate while refactoring:

- pick one or two documents (issue + PR is a good pair)
- index them via live
- run them via simulation
- compare:
  - moment row provenance fields (document id, author, createdAt, source metadata, time range metadata)
  - link audit payload shapes (keys/structure, null vs missing) for linking decisions

Record mismatches in the worklog and decide whether to align them in the current step.

Clarify: what I meant by 'Phase A core extraction'

We converged the 'changed' meaning using an etag helper, but Phase A in the original plan included more than that:

- document preparation via plugins
- stable chunking and chunk identity
- producing the document-level artifacts that downstream phases consume

Right now, live and simulation both do versions of that work, but not via a shared orchestration boundary in the same style as the linking orchestrators. The proposed next step is to apply the same 'core calls ports' pattern so that Phase A behavior is expressed once, and adapters only supply I/O (read the doc, persist artifacts).

Re-centered next steps (attempt)

1. Move simulation state DB module under engine/databases
   - Move `src/app/engine/simulationDb/` -> `src/app/engine/databases/simulationState/`
   - Update imports across engine, worker exports, tests, and UI
   - Keep behavior unchanged
   - Run pnpm build + MACHINEN_TEST_FORCE_DEV=1 pnpm test:simulation

2. Apply the 'core orchestrator calls ports' pattern to micro_batches, macro_synthesis, materialize_moments
   - Create core orchestrators (one per phase) that express end-to-end phase behavior
   - Make live + simulation supply ports (read inputs, write outputs, call LLM, vector query, moment writes)
   - Keep simulation persistence model (restartable artifacts) and keep live writes minimal

3. Phase A: make a shared orchestrator boundary (beyond the etag helper)
   - Define the in-memory inputs/outputs for document prepare + chunking + diff identity
   - Keep existing storage decisions (simulation persists A artifacts; live stores what it already stores)

4. Provenance alignment checklist (as a gate on refactors)
   - For a small sample, compare stored moment fields + link audit payload shapes between live and simulation
   - Record mismatches and decide whether to align them as part of the current step

Progress: moved simulation state DB module under engine/databases

- moved `src/app/engine/simulationDb/` -> `src/app/engine/databases/simulationState/`
- updated imports in worker exports, audit UI, and engine routes
- fixed the internal re-export paths from the moved location

Checks

- pnpm build passes
- MACHINEN_TEST_FORCE_DEV=1 pnpm test:simulation passes