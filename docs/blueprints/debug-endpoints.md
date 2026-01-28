# Debug Endpoints Blueprint

**Status**: Living Document
**Last Updated**: 2026-01-27

## 1. Purpose

The Machinen system provides a suite of administrative and debug endpoints to investigate the state of simulations, ingestion pipelines, and the Knowledge Graph. These endpoints are primarily consumed by the Admin UI but can also be accessed via `curl` for automation or deep investigation.

## 2. General Principles

*   **Read-Only by Default**: Most debug endpoints should not mutate state. Mutations (like `pause`, `resume`, `restart`) are clearly marked.
*   **API Key Gated**: All administrative routes are protected by `requireQueryApiKey`.
*   **Context Aware**: Many endpoints require a `runId` or `namespace` to scope the investigation.

## 3. Simulation Endpoints

### 3.1 Lifecycle Management
*   `POST /admin/simulation/run/start`: Starts a new simulation.
*   `POST /admin/simulation/run/advance`: Manually triggers a phase advance check.
*   `POST /admin/simulation/run/pause`: Pauses a running simulation.
*   `POST /admin/simulation/run/resume`: Resumes a paused simulation.
*   `POST /admin/simulation/run/restart`: Restarts a simulation from a specific phase.

### 3.2 State & Events
*   `GET /admin/simulation/run/:runId`: Returns the top-level state of a simulation run.
*   `GET /admin/simulation/run/:runId/events`: Returns a stream of events (logs) for the run.
*   `GET /admin/simulation/run/:runId/debug/status`: Returns diagnostic information identifying stalled documents and batches.

### 3.3 Phase-Specific Drill-down
Pipelines register their own investigation routes in the `PipelineRegistryEntry`.

*   **Timeline Fit**: `GET /admin/simulation/run/:runId/timeline-fit-decisions?r2Key=...`
    *   Shows exactly why a moment was linked or rejected during the timeline fit phase.
*   **Macro Classification**: (Pattern exists for other phases to expose their intermediate artifacts).

## 4. Invariant Checking Endpoints

(Placeholder for endpoints that can verify system invariants on-demand).

## 5. Usage Patterns

### 5.1 Investigating a Stalled Run
1.  Check `/events` for the `runId` to see the last logged kind (e.g., `host.phase.dispatch`).
2.  Check the top-level state via `/:runId` to see `status` and `updated_at`.
3.  If `busy_running` but `updated_at` is old, the watchdog should have kicked in.
4.  Use drill-down endpoints to see if specific documents are failing or stuck in an adapter.
