# Plugin System Architecture

The core of the system is an extensible, hook-based plugin architecture. The engine acts as an orchestrator, managing data flow and state, while **Plugins** provide the source-specific logic for everything from parsing files to formatting LLM prompts.

## Core Concepts

### 1. Namespaces
To keep concerns separate, the plugin API is organized into namespaces corresponding to the two main subsystems:

*   **Root (Shared)**: Hooks that apply before subsystem-specific processing (e.g., `prepareSourceDocument`, `splitDocumentIntoChunks`).
*   **`evidence` (RAG)**: Hooks related to the **Evidence Locker**—vector search, reranking, and context reconstruction.
*   **`subjects` (Knowledge Graph)**: Hooks related to the **Knowledge Synthesis Engine**—extracting moments, finding subjects, and summarizing content.

### 2. Composition Strategies
Since multiple plugins can be active simultaneously, the engine uses specific strategies to combine their results for each hook:

*   **`First-Match`**: The engine invokes plugins in order. The first one to return a non-null value "wins," and subsequent plugins are skipped. This is used for source-specific logic where only one handler should apply (e.g., parsing a specific file type).
*   **`Waterfall`**: The output of one plugin becomes the input for the next, forming a sequential chain. This is used for transformations (e.g., enriching chunks or re-ranking search results).
*   **`Collector`**: The engine invokes all plugins and aggregates their non-null results into an array. This is used when multiple sources need to contribute to a single outcome (e.g., building search filters).

## The Anatomy of a Plugin

A plugin is simply a JavaScript object that implements the `Plugin` interface.

```typescript
const MyPlugin: Plugin = {
  name: "MyPlugin",

  // --- Shared Hooks ---
  prepareSourceDocument: async (context) => { /* ... */ },
  splitDocumentIntoChunks: async (doc, ctx) => { /* ... */ },

  // --- Evidence Locker (RAG) Hooks ---
  evidence: {
    enrichChunk: async (chunk, ctx) => { /* ... */ },
    // ...
  },

  // --- Knowledge Graph (Synthesis) Hooks ---
  subjects: {
    extractMicroMomentsFromDocument: async (doc, ctx) => { /* ... */ },
    // ...
  }
};
```

## Hook Reference

### Shared Hooks

#### `prepareSourceDocument`
*   **Purpose**: To identify a raw source file (from R2) and transform it into a standardized `Document` object. This is the entry point for all indexing.
*   **Strategy**: `First-Match`

#### `splitDocumentIntoChunks`
*   **Purpose**: To break a `Document` into a stable, ordered list of `Chunk` objects. This chunk stream is used by both the Evidence Locker and the Knowledge Synthesis Engine.
*   **Strategy**: `First-Match`

### Evidence Locker (RAG) Hooks

#### `enrichChunk`
*   **Purpose**: To add metadata or computed fields to a chunk before it is hashed and indexed.
*   **Strategy**: `Waterfall`

#### `prepareSearchQuery`
*   **Purpose**: To transform or expand the user's raw query string before vectorization (e.g., keyword expansion).
*   **Strategy**: `Waterfall`

#### `buildVectorSearchFilter`
*   **Purpose**: To contribute structured filters to the vector search (e.g., `source: 'github'`).
*   **Strategy**: `Collector`

#### `rerankSearchResults`
*   **Purpose**: To re-order or filter the raw results from the vector database.
*   **Strategy**: `Waterfall`

#### `reconstructContext`
*   **Purpose**: To take a set of chunks and the original source document and format them into a human-readable text block for the LLM.
*   **Strategy**: `First-Match`

#### `optimizeContext`
*   **Purpose**: To fit the reconstructed contexts into the LLM's token window (e.g., by trimming or prioritizing).
*   **Strategy**: `Waterfall`

#### `composeLlmPrompt`
*   **Purpose**: To aggregate all optimized contexts into the final string prompt for the LLM.
*   **Strategy**: `Waterfall`

#### `formatFinalResponse`
*   **Purpose**: To post-process the LLM's response (e.g., adding citations).
*   **Strategy**: `Waterfall`

### Knowledge Graph (Subjects) Hooks

#### `computeMicroMomentsForChunkBatch`
*   **Purpose**: To compute a list of "Micro-Moments" for a batch of chunks. This is an engine-owned performance primitive used to reduce work on cold caches without defining semantic boundaries.
*   **Strategy**: `First-Match`
*   **Notes**:
    *   The engine batches chunks for performance (token/size caps), not for semantic boundaries.
    *   The hook can use an LLM to return a list of "what happened" items.
    *   Provenance is handled by the engine at the batch level: a micro-moment produced from a batch is attributed to the batch's chunk ids/hashes.

#### (Macro synthesis) source formatting and reference context
During macro-moment synthesis, the engine constructs a prompt that includes generic formatting rules plus a source-specific block.

The source-specific block is returned by a per-source plugin hook. The engine concatenates this block into the macro synthesis prompt verbatim.

This hook output is intended to include:

- Formatting guidance (how the title should label the source, how canonical tokens should appear in summaries)
- Reference context for the current document (canonical tokens for the document and relevant entities like comments or messages)

The canonical token format is:

- `source:document_type/path`

