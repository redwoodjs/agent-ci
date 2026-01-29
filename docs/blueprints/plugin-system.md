# Plugin System Blueprint

## 1. Purpose
The Machinen Plugin System provides an extensible, hook-based architecture for source-specific logic. It allows the core engine to remain source-agnostic while supporting diverse data formats (GitHub, Discord, etc.) for both the Evidence Locker (RAG) and the Knowledge Synthesis Engine.

## 2. Core Concepts

### 2.1 Hook Namespaces
Plugins are organized into functional namespaces:
*   **Root (Shared)**: Lifecycle hooks that apply before subsystem-specific processing (e.g., preparation, chunking).
*   **`evidence`**: Hooks for the Evidence Locker (vector search, reranking, context reconstruction).
*   **`subjects`**: Hooks for the Knowledge Synthesis Engine (moment extraction, summarization).

### 2.2 Composition Strategies
The engine orchestrates multiple plugins using three primary strategies:

| Strategy | Behavior | Use Case |
| :--- | :--- | :--- |
| **`First-Match`** | Invokes plugins in order; the first **non-null/non-undefined** value wins. | Source-specific logic (e.g., parsing, chunking). |
| **`Waterfall`** | Sequentially chains plugins; output of $N$ is input to $N+1$. | Transformations (e.g., enrichment, re-ranking). |
| **`Collector`** | All plugins are invoked; non-null results are aggregated. | Collaborative inputs (e.g., building search filters). |

## 3. The Plugin Contract (Invariants)

To ensure the orchestrator works correctly, all plugins MUST adhere to these invariants:

### 3.1 Non-Match Explicit Return
For `First-Match` hooks, a plugin MUST return `null` (or `undefined`) if it does not handle the given document or context.
*   **CORRECT**: `if (doc.source !== "github") return null;`
*   **INCORRECT**: `if (doc.source !== "github") return [];` (Returning an empty array is considered a "match" in the orchestrator).

### 3.2 Idempotency
Any hook that performs transformations (Waterfall) must be idempotent or side-effect-free relative to the engine's state.

### 3.3 Isolation
Plugins must not share state with other plugins. Communication between plugins occurs only through the standard hook inputs/outputs defined by the engine.

## 4. Hook Reference

### 4.1 Shared Hooks
*   **`prepareSourceDocument`**: Transforms raw R2 data into a standardized `Document`. (Strategy: `First-Match`)
*   **`splitDocumentIntoChunks`**: Breaks a `Document` into a stable, ordered list of `Chunk` objects. (Strategy: `First-Match`)

### 4.2 Evidence Locker Hooks
*   **`enrichChunk`**: Adds metadata to a chunk before indexing. (Strategy: `Waterfall`)
*   **`buildVectorSearchFilter`**: Contributes structured filters to queries. (Strategy: `Collector`)
*   **`reconstructContext`**: Formats chunks and source data for the LLM. (Strategy: `First-Match`)

### 4.3 Knowledge Graph Hooks
*   **`getMicroMomentBatchPromptContext`**: Provides source-specific instructions for micro-moment extraction. (Strategy: `First-Match`)
*   **`getMacroSynthesisPromptContext`**: Provides source-specific formatting and context for final summarization. (Strategy: `First-Match`)
