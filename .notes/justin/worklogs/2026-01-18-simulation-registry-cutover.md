# 2026-01-18-simulation-registry-cutover

## Goal

Refactor simulation pipelines to be registry-driven, colocating engine and web (UI/routes) logic within each pipeline's directory. This eliminates scattered switch statements and hardcoded routing table drift.

### Core Structure

Each pipeline under `src/app/pipelines/<name>/` will follow this layout:

- `engine/`: Core logic, live indexing, and simulation adapters/runners.
- `web/routes/`: Artifact endpoints for simulation data.
- `web/ui/`: UI components for the simulation audit view.

### Registry

A central registry in `src/app/engine/simulation/registry.ts` will be the source of truth for:
- Phase ordering.
- Runner mapping (dispatch).
- UI component mapping.
- Route registration.

## Plan

- [x] Audit current per-phase routes in `src/app/engine/routes/simulation.ts`.
- [x] Audit current per-phase UI sections in `src/app/pages/audit/subpages/simulation-runs-page.tsx`.
- [x] Create `registry.ts` with the basic phase list and runner mapping.
- [x] For each pipeline:
    - [x] Create `web/routes/` and move relevant artifact handlers there.
    - [x] Create `web/ui/` and move relevant summary/drilldown components there.
    - [x] Register them in the central registry.
- [x] Update simulation runner (`src/app/engine/runners/simulation/runner.ts`) to use the registry.
- [x] Update `src/app/pages/audit/subpages/simulation-runs-page.tsx` to dynamically render phase UI from the registry.
- [x] Update server route mounting to dynamically register pipeline routes.
- [x] Cleanup: delete shims and hardcoded switches.
- [x] Gate with `pnpm -s build`.

## Progression

### Audit Complete
Checked all the routes and UI components.

### Implementation Complete
Registry is live. All 8 phases are colocated. Built successfully.

Next steps for Justin:
1. Enforce boundaries for `candidate_sets` and `timeline_fit`.
2. Move remaining business logic from `simulation-actions.ts` into pipeline runners if appropriate.
