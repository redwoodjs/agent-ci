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

