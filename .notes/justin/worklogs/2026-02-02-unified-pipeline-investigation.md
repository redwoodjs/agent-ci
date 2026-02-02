# Unified Pipeline Investigation [2026-02-02]

## Priming: Reconciling Blueprints with Reality
We started by reviewing the existing `docs/blueprints/unified-pipeline.md` and `docs/architecture/system-flow.md`.
We highlighted a critical gap: the blueprints describe an "ideal" state that may not match the actual code, specifically regarding "Stateless Execution" and the integration of "Plugins".
We also need to incorporate a concrete "Prefetching" example to illustrate the end-to-end flow.

## Investigated the Plugin Architecture
We examined `src/app/engine/plugins` and specifically `github.ts` to understand where domain logic lives.
**Findings:**
*   Plugins are the "Domain Drivers". `github.ts` implements interfaces for `prepareSourceDocument` (Ingest), `splitDocumentIntoChunks` (Micro-Batching), and `getMicroMomentBatchPromptContext` (Prompting).
*   This confirms that "Ingestion" and "Diffing" logic is largely delegated to these plugins, which fits the "Unified" model (logic is shared).

## Investigated Micro-Bubbles & Statelessness
We looked at `src/app/pipelines/micro_batches/engine/core/orchestrator.ts` and `src/app/engine/types.ts`.
**Findings:**
*   **Micro-Batching**: The `MicroBatchesOrchestrator` takes `chunkBatches` and produces `MicroMoment` items. It uses a "Ports" pattern (`MicroBatchesOrchestratorPorts`) to decouple logic from I/O, which supports the "Stateless" goal.
*   **Context**: `IndexingHookContext` (in `types.ts`) carries the `env` and `momentGraphNamespace`, effectively acting as the "Side-Effect Handle" passed to stateless functions.
*   **Terminology**: The code uses `MicroMoment` (embeddings) and `MacroMoment` (synthesis), which aligns with the user's mental model, but the blueprints need to be explicit about this distinction.

## Work Task Blueprint: Blueprint Updates

### Goal Description
Update the Architecture Blueprints to reflect the reality of the Unified Orchestrator, specifically integrating Plugins, clarifying Stateless Context, and adding the Prefetching example.

### Proposed Changes

#### [MODIFY] `docs/blueprints/unified-pipeline.md`
*   **Phase Definitions**:
    *   Explicitly map `Micro-Batches` to "Embedding/Chunking".
    *   Explicitly map `Materialize` to "Graph Commitment".
*   **Plugin Architecture**:
    *   Add a section explaining how `Plugins` (e.g., `github.ts`) inject logic into the pipeline phases.
*   **Stateless Context**:
    *   Detail the `PipelineContext` / `IndexingHookContext` interfaces as the mechanism for side-effects.
*   **Prefetching Example**:
    *   Replace the generic walkthrough with the specific "Support Prefetching" scenario (Issue #22 -> Discord -> PR #25 -> Announce).

#### [MODIFY] `docs/architecture/system-flow.md`
*   **Narrative Updates**:
    *   Align phase descriptions with the strict definitions in `unified-pipeline.md`.
    *   Ensure the "Simulation" narrative reflects the "Unified" reality (it's just a different Strategy for the same Code).

### Verification
*   **The Deletion Test**: Verify that the new blueprints contain enough detail (interfaces, constraints) to reconstruct `src/app/engine/types.ts` conceptually.