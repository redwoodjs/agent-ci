# Phase-first architecture rules (engine + simulation)

These rules exist to prevent repeated regressions where orchestration or LLM logic leaks into adapters, and to keep the codebase truly **phase-first** and **registry-driven**.

## Phase-first layout (required)

- Each phase must live under `src/app/engine/phases/<phaseId>/`.
- Phase code should be co-located:
  - `core/` — phase orchestrator + helpers (source of truth for behavior)
  - `simulation/` — simulation runner + simulation adapter (I/O only)
  - `live/` — live adapter (I/O only)
  - `ui/` — UI for phase artifacts (if any)
  - `routes/` — phase routes (optional; prefer registry-driven generation)

## Core vs adapter separation (required)

### Core orchestrator responsibilities

- Own **control flow** and sequencing for the phase.
- Contain **deterministic gating/selection logic** (if any).
- Perform **LLM calls** only via injected ports.
- Perform **vector queries** only via injected ports.
- Return structured outputs and audit payloads that can be persisted by adapters.

### Adapter responsibilities (simulation/live)

Adapters are **I/O only**:

- Read inputs/artifacts needed for the phase.
- Call the phase core orchestrator.
- Persist outputs/artifacts.
- Translate/serialize shapes.
- Map errors to persisted error rows / events.

Adapters must not:

- Contain gating/selection/business logic.
- Call LLMs (no direct `callLLM`, no direct prompt assembly).
- Call vector index APIs directly.
- Implement phase-specific orchestration beyond “read → call core → write”.

## Ports injection (required)

- Core orchestrators must accept a single `ports` object that contains all external effects.
- Adapters implement the port functions by wiring to:
  - DB access
  - moment graph access
  - vector index access
  - LLM utilities
  - environment/config

Core should not import concrete simulation DB helpers directly.

## Registry-driven wiring (required)

- Phase ordering + dispatch should be centralized (registry-driven).
- UI navigation and rendering for simulation artifacts should be centralized (registry-driven).
- Avoid scattered per-phase `if/else` chains in runner, routes, and UI.

## No shims in final state (required)

- Re-export shims are allowed only as temporary scaffolding.
- After cutover (imports updated), delete old locations; do not keep “compat” modules.

