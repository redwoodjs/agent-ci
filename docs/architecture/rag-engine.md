# RAG Engine Architecture

The RAG (Retrieval-Augmented Generation) engine is a plugin-based system designed to index and query information from multiple, heterogeneous data sources. Its architecture is built to operate efficiently on the Cloudflare serverless stack and is shaped by several core challenges.

## The Challenges

### 1. Data Retrieval in a Serverless Environment

A RAG system's effectiveness hinges on its vector database. In a serverless environment like Cloudflare Workers, this presents unique constraints. A viable solution must scale beyond a single worker's memory limits and, critically, must support efficient **metadata filtering** at the database level. Without this, combining a semantic vector search with a structured filter (e.g., `source: 'github' AND author: 'justinvdm'`) would require a slow, inefficient, and costly two-step process: first fetch a large number of vector results, then filter them in application code. This led to the selection of a managed vector database (Cloudflare Vectorize) that handles these requirements natively.

### 2. Supporting Multiple, Heterogeneous Data Sources

The engine cannot have source-specific logic (e.g., how to parse a GitHub PR vs. a Cursor conversation) hardcoded into its core. Such a design would be monolithic and unmaintainable. The system requires a design that decouples the core indexing and querying logic from the specifics of each data source, allowing new sources to be added without modifying the engine itself.

### 3. Reconstructing Coherent Context from Disconnected Chunks

A vector search, by its nature, returns a flat list of semantically similar but disconnected "chunks" of text. The engine's primary challenge at query time is to transform this disconnected list into a coherent, readable block of context to feed to an LLM. A naive implementation that simply concatenates chunk text is insufficient. The system must be able to group related chunks (e.g., all comments from a single PR) and format them intelligently, and even handle advanced use cases like weaving a chronological narrative from chunks originating from different sources.

### 4. Decoupling Query Logic from Storage Schema

An early implementation of the context reconstruction logic relied on parsing the R2 object key (`documentId`) to determine the type of document it was and how to format it. This created a brittle, implicit contract between the file storage layout and the query-side logic. A change in the R2 path structure would break the query engine, tightly coupling concerns that should be separate.

### 5. Maintaining Index Synchronization on Document Updates

When a source document is updated (e.g., a new comment is added to a GitHub PR), the vector index must be updated to reflect the change. A naive implementation that simply inserts new vectors for the updated document would leave the old, stale vectors in the index. This "index pollution" would degrade the quality of search results over time by providing outdated and contradictory context to the LLM.

## The Architecture

The architecture is a plugin-driven pipeline for indexing and querying, designed specifically to solve the challenges above.

### 1. The Plugin System

To solve for extensibility, the engine's core is a hook-based plugin system. The engine orchestrates the data flow, and plugins provide the source-specific implementation details for each stage.

*   **Hooks**: The engine defines a series of hooks for both indexing and querying (e.g., `prepareSourceDocument`, `splitDocumentIntoChunks`, `reconstructContext`).
*   **Composition Strategies**: The engine uses different strategies (First-Match, Waterfall, Collector) to combine the outputs of multiple plugins for a given hook, providing predictable control over the pipeline.

### 2. The Two-Stage Query Pipeline for Context Assembly

To solve the challenge of reconstructing coherent context, the query pipeline is separated into two distinct stages:

*   **Stage 1: Reconstruct Context (`reconstructContext` hook)**: In this stage, the engine first groups search results by their parent document. For each document, it calls the appropriate plugin, whose sole responsibility is to take the full source JSON and the relevant chunks and format them into a single, self-contained, readable block (e.g., a markdown representation of a PR and all its comments).
*   **Stage 2: Aggregate Contexts (`composeLlmPrompt` hook)**: The engine then collects these pre-formatted blocks and passes them to the `composeLlmPrompt` hook. This hook's responsibility is **aggregation**. It can simply join the blocks, or a more advanced plugin could use the rich metadata preserved from Stage 1 to re-order the blocks chronologically, creating a unified narrative from multiple sources.

This separation of concerns makes the process efficient (each source document is fetched only once) and powerful, enabling both simple and complex prompt assembly strategies.

### 3. Explicit, Namespaced Metadata

To decouple query logic from the storage schema, the system uses an explicit metadata contract.

*   **`sourceMetadata`**: A generic `sourceMetadata` field exists on each chunk's metadata. At indexing time, a plugin populates this field with a structured object containing explicit identifiers (e.g., `{ type: 'github-pr-issue', owner: '...', number: 123 }`).
*   **At Query Time**: The `reconstructContext` hook reads directly from this structured object to determine how to format the content. It no longer needs to parse the R2 key, making the system robust and making each plugin's data contract self-contained.

### 4. The "Delete-Then-Insert" Indexing Pipeline

To maintain index synchronization, the indexing pipeline employs a "delete-then-insert" strategy. When a document is re-indexed, the worker first issues a command to Vectorize to delete all existing vectors associated with that document's ID. Only after the old vectors have been purged does it proceed with generating new chunks and inserting the new vectors. This atomic operation ensures that the vector index remains a clean, up-to-date reflection of the source of truth in R2.
