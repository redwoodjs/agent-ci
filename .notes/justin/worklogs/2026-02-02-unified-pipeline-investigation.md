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