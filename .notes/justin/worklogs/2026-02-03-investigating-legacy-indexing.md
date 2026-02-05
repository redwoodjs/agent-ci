# Investigating Legacy Indexing Logic 2026-02-03

## Investigated the engine.ts legacy logic
We reviewed `src/app/engine/engine.ts` to identify obsolete code in the `indexDocument` function. We found that:
- `findMomentByMicroPathsHash` is a legacy caching mechanism that is no longer needed because we now use deterministic IDs based on document and stream metadata.
- `indexDocument` contains substantial logic (gating, classification, synthesis) that is duplicated or divergent from the new phase-based architecture.
- Specifically, the "Gating" logic (`isNoiseMacroMoment`) is not yet present in the `macro_synthesis` phase orchestrator, leading to potential noise in simulation runs.

## Decided to simplify engine.ts
We plan to:
1. Remove `findMomentByMicroPathsHash` usage.
2. Extract shared logic (Gating, Classification) into common libraries (`phaseCores`).
3. Refactor `indexDocument` to use these shared libraries, reducing its complexity and ensuring behavioral parity between Live and Simulation modes.

## Identified critical bugs and drafted implementation plan
We discovered that the Simulation UI is crashing due to property name mismatches (e.g., `momentId` vs `id`) and structural mismatches in phase artifact retrieval. We also found that `SUBJECT_INDEX` is missing from the environment, causing materialization errors. We have drafted an [implementation plan](file:///Users/justin/.gemini/antigravity/brain/910430a8-37bc-4821-9e84-b1ffca87b1a9/implementation_plan.md) to fix these issues and continue with the cleanup of legacy indexing logic.
