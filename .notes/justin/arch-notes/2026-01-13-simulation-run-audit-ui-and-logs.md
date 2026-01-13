# Simulation run audit UI and persisted run logs

## Problem

Simulation runs are currently driven through admin endpoints and tests. When a run pauses or fails, the primary information is whatever ends up in console logs. That makes it hard to debug failures after the fact, and it pushes basic iteration into curl + log tail workflows.

## Constraints

- Runs need to be debuggable after they stop.
- Logging volume needs a cap by default.
- A run should have a single place to inspect "what happened" without reading worker logs.
- The audit data should be run-scoped so it behaves like CI logs for a single run.

## Proposal

Add a run-scoped audit log that is persisted per run and surfaced in the UI.

The audit log is a stream of structured events. The UI renders it as text, with optional expansion for structured payloads.

### UI surfaces

- Runs list
  - run id
  - status
  - current phase
  - timestamps (created, updated, completed if any)
  - counts (events, documents, micro batches) when cheap
- Run detail
  - current phase and status
  - control actions: start, advance, pause, resume, restart-from-phase
  - audit log stream
  - drilldowns into run artifacts that exist at the current step (documents, micro batches)

### Persisted event shape

Each event should include:

- timestamp
- severity (debug/info/warn/error)
- event kind (phase_start, phase_end, item_error, progress, etc)
- message
- phase id (when applicable)
- item identity (when applicable) so failures can be tied to a concrete unit of work
- structured payload for error details and counts

### Logging behavior

- Any place the simulation runner logs, it also persists a run event.
- Default persistence is warn/error.
- Info/debug persistence is enabled only when configured (env flag or per-run flag).
- Errors should include enough structured data to debug without worker logs (error name, message, stack when available, and any item identity available at the call site).

### Implementation direction

Use a small run logger helper that writes to:

- console (for immediate dev feedback)
- the run event store (for UI and after-the-fact debugging)

Call sites should not decide between the two sinks.

