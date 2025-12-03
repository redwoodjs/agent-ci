# RAG Engine Architecture

The RAG (Retrieval-Augmented Generation) engine is a plugin-based system designed to index and query information from multiple, heterogeneous data sources. Its architecture is built to operate efficiently on the Cloudflare serverless stack and is shaped by several core challenges.

## The Challenges

### 1. Data Retrieval in a Serverless Environment

A RAG system's effectiveness hinges on its vector database. In a serverless environment like Cloudflare Workers, this presents unique constraints. A viable solution must scale beyond a single worker's memory limits and, critically, must support efficient **metadata filtering** at the database level. Without this, combining a semantic vector search with a structured filter (e.g., `source: 'github' AND author: 'justinvdm'`) would require a slow, inefficient, and costly two-step process: first fetch a large number of vector results, then filter them in application code.

### 2. Accommodating Heterogeneous Data Sources

Each data source-from GitHub issues to Discord conversations-has its own unique structure, metadata, and semantics. The system must be able to understand and process these differences to build a coherent, searchable index.

### 3. Maintaining a Complete and Fresh Index

The information in our data sources is constantly changing. New issues are created, PRs are updated, and conversations evolve. The index must reflect these changes in a timely manner without requiring a full, costly re-indexing of all documents. Furthermore, relying solely on real-time events to trigger indexing is not robust; events can be missed during outages, leading to parts of the knowledge base never being indexed. The system needs a reliable, systematic process to handle both real-time updates and bulk backfills.

### 4. Decoupling Query Logic from Storage Schema

An early implementation of the context reconstruction logic relied on parsing the R2 object key (`documentId`) to determine the type of document it was and how to format it. This created a brittle, implicit contract between the file storage layout and the query-side logic. A change in the R2 path structure would break the query engine, tightly coupling concerns that should be separate.

### 5. Maintaining Index Synchronization on Document Updates

When a source document is updated (e.g., a new comment is added to a GitHub PR), the vector index must be updated. A naive implementation that simply inserts new vectors would leave the old, stale vectors in the index. This "index pollution" degrades the quality of search results over time by providing outdated and contradictory context to the LLM. The system requires an atomic "delete-then-insert" operation, but a key challenge is efficiently identifying which vectors to delete without performing slow and costly queries.

## The Architecture

The architecture is a plugin-driven pipeline for indexing and querying, designed specifically to solve the challenges above.

### 1. The Two-Tiered Knowledge System

To effectively answer both "what" and "why" questions, the engine maintains two distinct but connected knowledge stores.

*   **The Evidence Locker**: This is a traditional RAG vector index (Cloudflare Vectorize) containing fine-grained, content-addressable `Chunk`s of source documents. Its purpose is to provide the specific, factual evidence needed to answer a question. It is optimized for semantic search over raw content.

*   **The Knowledge Graph**: This is a more structured store (a Durable Object) containing "Subject" nodes. A Subject is a synthesized entity that represents a coherent topic, conversation, or unit of work (e.g., "Feature: User Profile Page"). It contains a running `narrative`, metadata, and relationships to other Subjects (`parentId`, `childIds`). Its purpose is to hold the high-level, synthesized understanding of a topic, answering "why" questions by providing context and narrative that spans multiple pieces of evidence.

When a document is indexed, its chunks are vectorized and added to the Evidence Locker, while the engine's subject-correlation logic updates the state of the appropriate Subject in the Knowledge Graph.

### 2. The Plugin System

To solve for extensibility, the engine's core is a hook-based plugin system. The engine orchestrates the data flow, and plugins provide the source-specific implementation details for each stage. The engine uses different composition strategies (First-Match, Waterfall, Collector) to combine the outputs of multiple plugins for a given hook, providing predictable control over the pipeline.

### 3. The Two-Stage Query Pipeline for Context Assembly

To solve the challenge of reconstructing coherent context, the query pipeline is separated into two distinct stages:

*   **Stage 1: Reconstruct Context (`reconstructContext` hook)**: In this stage, the engine first groups search results by their parent document. For each document, it calls the appropriate plugin, whose sole responsibility is to take the full source JSON and the relevant chunks and format them into a single, self-contained, readable block (e.g., a markdown representation of a PR and all its comments).
*   **Stage 2: Aggregate Contexts (`composeLlmPrompt` hook)**: The engine then collects these pre-formatted blocks and passes them to the `composeLlmPrompt` hook. This hook's responsibility is **aggregation**. It can simply join the blocks, or a more advanced plugin could use the rich metadata preserved from Stage 1 to re-order the blocks chronologically, creating a unified narrative from multiple sources.

### 4. Explicit, Namespaced Metadata

To decouple query logic from the storage schema, the system uses an explicit metadata contract. A generic `sourceMetadata` field exists on each chunk's metadata. At indexing time, a plugin populates this field with a structured object containing explicit identifiers (e.g., `{ type: 'github-pr-issue', owner: '...', number: 123 }`). At query time, the `reconstructContext` hook reads directly from this structured object.

#### 5. Incremental Indexing via Stateful Diffing

To solve for both index freshness and the high cost of re-processing large, frequently-updated documents (the "whale" problem), the engine uses a stateful, incremental indexing strategy. This logic is managed by the `EngineIndexingStateDO`, a Durable Object that tracks the processing state of each document.

The process is as follows:

1.  **ETag Check**: The first check is on the R2 object's `etag`. If it matches the `etag` stored in the state DO from the last run, the file has not changed, and the entire process is skipped.
2.  **Chunk-Level Diffing**: If the `etag` is new, the engine splits the document into `Chunk`s and calculates a content hash for each one. It then fetches the list of previously-indexed chunk hashes from the state DO.
3.  **Process Only New Chunks**: The engine compares the new set of chunk hashes with the old set and processes **only the chunks that are new or have been modified**. All unchanged chunks are ignored.
4.  **State Update**: After the new chunks have been successfully processed and indexed, the state DO is updated with the new `etag` and the complete, current list of all chunk hashes for the document.

This "diff-and-queue" approach ensures that only the minimal amount of work is done for any given update, making the pipeline highly efficient.

### 6. Event-Driven Architecture for Index Freshness

To ensure the index is always complete and to handle the high volume of files efficiently, the system uses a two-pronged, event-driven architecture instead of a continuous cron-based scanner.

1.  **Real-Time Indexing via R2 Event Notifications**: The R2 bucket is configured to send a message to a queue whenever a file is created or updated. A worker consumes from this queue and triggers the indexing pipeline for that specific file. This is a highly efficient, push-based approach for keeping the index synchronized with new changes.
2.  **Manual Backfill via an Admin Endpoint**: To process the large number of existing files without overwhelming the system, a protected admin endpoint is available. When triggered, this endpoint runs the "scan and compare" logic as a one-time operation, finding all unprocessed or updated files and enqueuing them for indexing.

This dual strategy provides a robust solution: real-time events handle day-to-day updates efficiently, while the manual backfill provides a controlled mechanism for bulk processing and disaster recovery, solving the scaling limitations of a cron-based approach.

## The Anatomy of a Plugin

A plugin is a JavaScript object that provides implementations for one or more hooks. The engine calls these hooks at specific points in the indexing and querying pipelines.

### Composition Strategies

The engine uses one of three strategies to handle hooks that are implemented by multiple plugins:

*   **`First-Match`**: The engine invokes plugins in order until one returns a non-null value. This is for source-specific logic where only one plugin should act.
*   **`Waterfall`**: The output of one plugin becomes the input for the next, creating a sequential chain of transformations.
*   **`Collector`**: The engine invokes all plugins and collects their results into an array. This is for situations where multiple plugins need to contribute.

### Plugin Namespaces

To keep concerns separate, the plugin API is organized into namespaces. Hooks related to the Evidence Locker are under the `evidence` key, and hooks related to the Knowledge Graph are under the `subjects` key.

```typescript
const MyPlugin: Plugin = {
  name: "MyPlugin",

  // Shared entry point
  prepareSourceDocument: async (context) => { /* ... */ },

  // Hooks for the Evidence Locker (RAG)
  evidence: {
    splitDocumentIntoChunks: async (document, context) => { /* ... */ },
    // ... other evidence hooks
  },

  // Hooks for the Subjects Knowledge Graph
  subjects: {
    determineSubjectsForDocument: async (document, chunks, context) => { /* ... */ },
    // ... other subject hooks
  }
};
```

### Indexing Hooks

These hooks are used when processing a source document to be added to the vector index.

#### `prepareSourceDocument`

*   **Purpose**: To identify a raw source file from R2 and transform it into a standardized `Document` object that the engine can understand.
*   **Composition**: `First-Match`

```typescript
// src/app/engine/plugins/github.ts
const GitHubPlugin: Plugin = {
  name: "GitHubPlugin",
  prepareSourceDocument: async (r2Key, r2ObjectBody, context) => {
    if (!r2Key.startsWith("github/")) {
      return null; // This plugin doesn't handle this source
    }

    const json = JSON.parse(r2ObjectBody);
    
    // ... logic to parse the JSON and extract metadata ...

    return {
      id: r2Key,
      content: json.body || "",
      source: "github",
      metadata: {
        title: json.title,
        // ... more metadata
      },
      sourceMetadata: {
        type: "github-pr-issue",
        owner: "...",
        // ... explicit, namespaced metadata
      },
    };
  },
  // ... other hooks
};
```

#### `splitDocumentIntoChunks`

*   **Purpose**: To break down a `Document`'s content into smaller, searchable `Chunk` objects. Each chunk inherits the parent document's metadata.
*   **Composition**: `First-Match`

```typescript
// src/app/engine/plugins/github.ts
const GitHubPlugin: Plugin = {
  // ...
  splitDocumentIntoChunks: async (document, context) => {
    if (document.source !== "github") {
      return null;
    }
    
    const chunks: Chunk[] = [];

    // Chunk for the main body
    chunks.push({
      content: document.content,
      metadata: { ...document.metadata, type: "issue-body" },
    });

    // Chunks for each comment
    const sourceJson = JSON.parse(await context.env.MACHINEN_BUCKET.get(document.id).then(o => o.text()));
    for (const comment of sourceJson.comments) {
      chunks.push({
        content: comment.body,
        metadata: { ...document.metadata, type: "issue-comment", author: comment.author },
      });
    }

    return chunks;
  },
  // ...
};
```

#### `determineSubjectsForDocument`

*   **Purpose**: A source-aware hook to perform top-down analysis of a document and its chunks to determine which `Subject`(s) they belong to. It returns an array of `SubjectDescription` objects.
*   **Composition**: `First-Match`

This is the primary hook for intelligent, source-specific subject correlation (e.g., treating a whole GitHub issue as a single subject). If not implemented, the engine falls back to a chunk-by-chunk analysis.

### Query Hooks

These hooks are used when a user submits a query to the engine.

#### `buildVectorSearchFilter`

*   **Purpose**: To contribute a filter clause to the Vectorize query, allowing for hybrid search (semantic + metadata).
*   **Composition**: `Collector`

```typescript
const MyFilterPlugin: Plugin = {
  name: "MyFilterPlugin",
  buildVectorSearchFilter: async (context) => {
    // Example: only search within the 'redwoodjs' GitHub org
    return {
      "sourceMetadata.owner": "redwoodjs",
    };
  },
  // ...
};
```

#### `rerankSearchResults`

*   **Purpose**: To re-order, filter, or boost the raw list of search results returned from the vector database.
*   **Composition**: `Waterfall`

```typescript
const MyRerankerPlugin: Plugin = {
  name: "MyRerankerPlugin",
  rerankSearchResults: async (results, context) => {
    // Example: Boost results from a specific author
    return results.sort((a, b) => {
      if (a.metadata.author === "important-person") return -1;
      if (b.metadata.author === "important-person") return 1;
      return 0;
    });
  },
  // ...
};
```

#### `reconstructContext`

*   **Purpose**: To transform the chunks related to a *single document* into a formatted, human-readable block of text. This is the first stage of prompt assembly.
*   **Composition**: `First-Match`

```typescript
// src/app/engine/plugins/github.ts
const GitHubPlugin: Plugin = {
  // ...
  reconstructContext: async (documentChunks, sourceDocument, context) => {
    const { sourceMetadata } = documentChunks[0].metadata;
    if (sourceMetadata?.type !== 'github-pr-issue') {
      return null;
    }

    const docSections: string[] = [];
    docSections.push(`## Issue #${sourceDocument.number}: ${sourceDocument.title}`);
    
    // ... logic to find body and comment chunks and add them to docSections ...

    return {
      content: docSections.join("\n"),
      source: "github",
      primaryMetadata: documentChunks[0].metadata,
    };
  },
  // ...
};
```

#### `optimizeContext`

*   **Purpose**: To filter, truncate, or re-order the list of `ReconstructedContext` objects before they are assembled into the final prompt. This is used for enforcing token budgets.
*   **Composition**: `Waterfall`

```typescript
const TokenBudgetPlugin: Plugin = {
  name: "TokenBudgetPlugin",
  optimizeContext: async (contexts, query, context) => {
    const MAX_TOKENS = 80000;
    const optimized: ReconstructedContext[] = [];
    let tokenCount = 0;

    for (const ctx of contexts) {
      const ctxTokens = estimateTokens(ctx.content);
      if (tokenCount + ctxTokens <= MAX_TOKENS) {
        optimized.push(ctx);
        tokenCount += ctxTokens;
      } else {
        break; // Budget full
      }
    }
    return optimized;
  },
  // ...
};
```

#### `composeLlmPrompt`

*   **Purpose**: To aggregate the pre-formatted context blocks from multiple sources into the final prompt that will be sent to the LLM.
*   **Composition**: `Waterfall`

```typescript
// A simple aggregator plugin
const DefaultPromptComposerPlugin: Plugin = {
  name: "DefaultPromptComposerPlugin",
  composeLlmPrompt: async (contexts, query, context) => {
    const contextSection = contexts.map(ctx => ctx.content).join("\n\n---\n\n");
    
    return `Based on the following context, answer the user's question.
    
    Context:
    ${contextSection}
    
    Question:
    ${query}`;
  },
  // ...
};
```

#### `formatFinalResponse`

*   **Purpose**: To format the raw text response from the LLM before returning it to the user, for example by adding citations or converting it to Markdown.
*   **Composition**: `Waterfall`

```typescript
const CitationPlugin: Plugin = {
  name: "CitationPlugin",
  formatFinalResponse: async (llmResponse, searchResults, context) => {
    const sources = [...new Set(searchResults.map(r => r.metadata.url))];
    const sourcesMarkdown = sources.map(url => `- ${url}`).join("\n");

    return `${llmResponse}\n\n**Sources:**\n${sourcesMarkdown}`;
  },
  // ...
};
```
