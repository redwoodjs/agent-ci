# Phase cores and adapters (live + simulation convergence)

## Problem

Simulation phases A-G exist as a restartable pipeline with persisted artifacts and run-scoped audit logs.

Live indexing performs similar work, but it is implemented as a separate pipeline. That makes it easy for simulation and live to drift in:

- what 'changed' means
- what inputs are reused or recomputed
- what is written into moment rows and link audit logs

That drift makes it harder to use simulation runs as a proxy for live behavior.

## Constraints

- Keep the split-module approach (no single monolithic pipeline module).
- Preserve simulation restart semantics and artifact inspection in the audit UI.
- Preserve live indexing behavior where possible, but accept some recomputation during convergence.
- Maintain provenance consistency between simulation and live (moment source metadata, document identifiers, time range metadata, link audit log payloads).
- Keep tests green throughout the refactor.

## Approach

Split each phase into two layers:

- Phase core: computes phase outputs from in-memory inputs and returns outputs plus structured events.
- Storage adapter: provides inputs to the core and applies outputs (simulation persists artifacts; live uses minimal persistence).

### Decision: core-authoritative identities

The phase core defines the input identity that is used for reuse decisions.

Adapters can store and read those identities, but should not use different definitions of 'same inputs'. This reduces drift where simulation and live disagree about when work can be skipped.

### Decision: deterministic moment IDs in live

Live indexing creates macro moments and writes them into the moment graph. Historically, the moment id for a newly created moment was a random uuid.

During convergence, live indexing now derives a deterministic moment id for a macro moment from stable inputs:

- identity scope (a constant string for live)
- effective namespace (or empty)
- document id
- stream id
- macro moment index within the stream

This allows reruns for the same document and stream to produce the same ids.

Compatibility constraint: when live indexing detects an existing moment (by micro paths hash lookup), it reuses the existing moment id. The deterministic id is only used for moments that do not already exist.

## Rollout

Start by extracting cores for phases B/C/D, then use the same cores from:

- the simulation phase executors (DB-backed adapter)
- the live indexing path (minimal adapter)

Then converge identities for A, and only then extract E-G cores.

## Provenance reminder

Before and during extraction, verify that simulation writes the same fields in the same shape as live for:

- moment rows
- link audit logs
- time range metadata used by time ordering guards

## Rollout continuation: Phase E deterministic_linking core

After Phase A 'changed' meaning is converged and B/C/D cores are shared, extract a core for deterministic_linking (Phase E).

### Inputs

- child moment identity (id, document id, createdAt, effective namespace)
- local stream context (previous moment id in stream, stream id, macro index)
- extracted anchor tokens for the child moment (from macro synthesis)
- optional candidate parent hints (for example, explicit references)
- a small, injected query surface for lookups needed by deterministic rules (for example, resolving a referenced parent id)

### Outputs

- a deterministic decision per moment:
  - attach (chosen parent id)
  - reject (reason and evidence)
  - skip (already linked or not eligible)
- structured events suitable for run-scoped audit logging and for document audit logs in live

### Invariants enforced by the core

- do not create cross-namespace links
- do not attach to a parent that is later than the child
- do not create cycles

### Adapter responsibilities

- simulation adapter reads materialized moments and prior decisions, applies the attachment to the moment graph, and persists the decision artifacts
- live adapter uses the same core to decide how to attach root moments during indexing, and writes comparable link audit payloads

## Rollout continuation: Phase F candidate_sets core

After Phase E proposal logic is shared, extract a core for candidate_sets (Phase F).

The goal is to converge the deterministic filtering and capping rules for candidate parents, independent of how candidates are retrieved.

### Inputs

- child moment identity and time metadata
- a list of candidate matches (ids + scores) from a retrieval adapter
- candidate moment rows (id, document id, createdAt, source metadata, title/summary) loaded by the adapter
- candidate caps and time ordering guard configuration

### Outputs

- ordered candidate list (bounded)
- stats payload for audit logging (counts, cap values, stop reason)

### Invariants enforced by the core

- do not include the child itself
- do not include candidates from the same document
- do not include candidates that are later than the child (time inversion guard)

### Adapter responsibilities

- simulation adapter performs embedding + vector retrieval and loads moment rows from the moment graph db, then persists the candidate list
- live adapter later reuses the same core to filter/cap candidates produced by the live retrieval path, and writes comparable audit payloads

## Rollout continuation: Phase G timeline_fit core

After candidate sets are persisted, extract a core for timeline_fit (Phase G).

The first version should converge on the live timeline-fit linking behavior (ranking + optional LLM veto) rather than choosing the first candidate.

### Inputs

- child moment identity
- candidate list (ordered, bounded) from Phase F
- time metadata needed for temporal guards
- optional timeline context needed for ranking and veto (bounded)
- dependencies for model calls and embedding (injected)

### Outputs

- chosen parent id (or null)
- decision list for audit logging (rank, selection, and reject reasons per candidate)
- stats payload (candidate count)

### Adapter responsibilities

- simulation adapter performs the actual moment graph write and validates whether the parent id changed, then persists the outcome and decisions
- live adapter uses the same core to choose a parent proposal and to produce comparable decision payloads around its parent selection write
