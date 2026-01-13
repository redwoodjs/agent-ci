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



