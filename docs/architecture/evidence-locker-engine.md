# Evidence Locker Architecture (RAG)

The Evidence Locker is the system's "long-term memory" for facts. It is a specialized RAG (Retrieval-Augmented Generation) engine designed to index and query information from multiple, heterogeneous data sources in a serverless environment.

## The Challenges

### 1. Data Retrieval in a Serverless Environment
A RAG system's effectiveness hinges on its vector database. In a serverless environment like Cloudflare Workers, this presents unique constraints. A viable solution must scale beyond a single worker's memory limits and, critically, must support efficient **metadata filtering** at the database level. Without this, combining a semantic vector search with a structured filter (e.g., `source: 'github' AND author: 'justinvdm'`) would require a slow, inefficient two-step process: fetch many results, then filter in code.

### 2. Maintaining a Complete and Fresh Index
The information in our data sources is constantly changing. New issues are created, PRs are updated, and conversations evolve. The index must reflect these changes in a timely manner without requiring a full, costly re-indexing of all documents.

### 3. Decoupling Query Logic from Storage Schema
Early implementations often tightly couple the storage layout (e.g., R2 paths) to the query logic. This creates a brittle system where moving a file breaks the search. The architecture must decouple these concerns using explicit metadata contracts.

### 4. Index Pollution
When a document is updated, simply inserting new vectors leaves old, stale vectors in the index ("index pollution"), degrading results. The system requires an efficient atomic update mechanism.

## The Architecture

### 1. Explicit, Namespaced Metadata
To decouple query logic from storage, the system uses an explicit metadata contract. A generic `sourceMetadata` field exists on each chunk's metadata.
*   **Indexing**: Plugins populate this with structured data (e.g., `{ type: 'github-pr-issue', owner: '...' }`).
*   **Querying**: The `reconstructContext` hook reads this structured object, ignoring the file path or storage location.

### 2. Incremental Indexing via Stateful Diffing
To solve for freshness and cost, the engine uses a stateful, incremental indexing strategy managed by the `EngineIndexingStateDO`.
1.  **ETag Check**: Skips processing if the source file hasn't changed.
2.  **Chunk-Level Diffing**: If the file changed, it is re-chunked. The engine compares new chunk hashes against the stored state from the previous run.
3.  **Minimal Updates**: Only *new or modified* chunks are sent to the embedding model and vector database. Unchanged chunks are left alone.

### 3. Event-Driven Indexing
To ensure freshness without polling:
*   **Real-Time**: R2 event notifications trigger a worker to index files immediately upon creation or update.
*   **Backfill**: A manual admin endpoint triggers a "scan and compare" for bulk processing/recovery.

### 4. Two-Stage Query Pipeline
To reconstruct coherent context from fragmented vector results:
*   **Stage 1: Reconstruct (`reconstructContext`)**: Results are grouped by document. A plugin hook fetches the full source and formats the relevant chunks into a readable block.
*   **Stage 2: Aggregate (`composeLlmPrompt`)**: These blocks are then aggregated, ordered, and optimized to fit the context window.

## Integration with Plugins
The Evidence Locker relies heavily on the Plugin System to handle the specifics of different file types. See `plugin-system.md` for details on the hooks:
*   `splitDocumentIntoChunks`
*   `enrichChunk`
*   `buildVectorSearchFilter`
*   `reconstructContext`

