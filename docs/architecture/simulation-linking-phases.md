# Simulation linking phases (deterministic_linking, candidate_sets, timeline_fit)

## Problem

The simulation runner currently reaches the point where moment rows exist (materialize_moments), but it does not perform cross-document linking.

Live indexing performs parent selection during indexing for a document's root moment. That makes timelines usable, but it is hard to restart, hard to inspect intermediate decisions, and easy for control-flow and caching semantics to drift from the simulation pipeline.

## Constraints

- A simulation run must be restartable from a phase boundary without recomputing earlier phase outputs.
- Linking must preserve invariants already required by the moment graph:
  - parent must not be later than child
  - do not create cycles
  - do not write cross-namespace links
- Work per item must be bounded (candidate counts, timeline context size, retries).
- Linking decisions must be inspectable in the simulation audit UI using persisted artifacts and events.
- The implementation should reuse the existing plugin surface for parent proposals so the same logic can later be reused by both simulation and live indexing.

## Approach

Add three simulation phases after materialize_moments:

- deterministic_linking
- candidate_sets
- timeline_fit

These phases are structured as progressive refinement. Each phase consumes persisted artifacts from prior phases and produces persisted artifacts for later phases.

### deterministic_linking

For each moment that is eligible for linking (typically root moments produced by materialize_moments):

- attempt deterministic parent selection using metadata and extracted anchor tokens
- if a deterministic rule yields a single parent, write the parent link in the moment graph
- record a decision artifact explaining why it attached or why it refused to attach

Deterministic rules are intended to have stable outcomes without model calls. Examples:

- explicit canonical references (for example, a fully-qualified source reference token)
- stable identifier tokens extracted during macro synthesis
- namespace and time-order guards applied as deterministic rejects

### candidate_sets

For moments that remain unlinked after deterministic_linking:

- compute a bounded list of candidate parents
- include evidence for each candidate (match kind, score, anchor overlap, time metadata)
- apply deterministic rejects (time inversion, namespace mismatch, missing rows)
- persist the candidate list as the phase output

This phase is responsible for enforcing caps on candidate count and for making candidate generation restartable without re-running selection logic.

### timeline_fit

For each unlinked moment with a persisted candidate set:

- choose a candidate parent using an expensive check when needed
- bound the check using a capped slice of candidate timeline context
- record the decision for each candidate (attach or reject) and the chosen parent when attached
- write the chosen parent link in the moment graph

The implementation can reuse the existing timeline-fit linker behavior (the same parent proposal logic used in live indexing) but with:

- explicit phase boundaries
- persisted candidate inputs
- persisted decisions and stop reasons

## Persisted artifacts

Each phase produces artifacts keyed so they can be reused on restart and inspected in the UI.

- deterministic_linking decisions:
  - moment id
  - attach or reject outcome
  - chosen parent id when attached
  - rule id and evidence payload

- candidate_sets:
  - moment id
  - ordered, bounded candidate list
  - per-candidate evidence payload
  - deterministic rejects with reasons

- timeline_fit decisions:
  - moment id
  - per-candidate decision record (inputs used, outcome, optional model output)
  - chosen parent id when attached

All phases also write run-scoped events for phase start/end, counts, and item failures.

## Restart semantics

- Restarting deterministic_linking does not require recomputing macro outputs or rematerializing moments.
- Restarting candidate_sets recomputes candidate lists, but does not redo deterministic linking.
- Restarting timeline_fit reuses the persisted candidate list and only recomputes the expensive decision phase.

If a phase fails for one or more items, the run transitions to paused_on_error and records the last error payload and failing item details in run events.

## Follow-up direction (after phases E-G exist)

Once these phases exist and are stable, split each phase into:

- a phase core that consumes in-memory inputs and emits outputs plus structured events
- a storage adapter that reads and writes persisted artifacts

This allows the same phase cores to be invoked by live indexing for a single document/event, while simulation keeps restartability and inspectability via its storage adapters.

Decision: core-authoritative identities

For the follow-up unification work, the phase core defines the input identity that is used for reuse decisions. Adapters can store and read those identities, but should not use different definitions of "same inputs".

This allows live indexing and simulation runs to converge on the same skip/reuse behavior, at the cost of some extra hashing and bookkeeping in live indexing while the pipelines are being unified.
