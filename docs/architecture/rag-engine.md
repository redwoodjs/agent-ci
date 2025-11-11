# RAG Engine Architecture

The RAG (Retrieval-Augmented Generation) engine is a plugin-based system designed to index and query information from multiple, heterogeneous data sources. Its architecture is built to operate efficiently on the Cloudflare serverless stack and is shaped by several core challenges.

## The Challenges

### 1. Data Retrieval in a Serverless Environment

A RAG system's effectiveness hinges on its vector database. In a serverless environment like Cloudflare Workers, this presents unique constraints. A viable solution must scale beyond a single worker's memory limits and, critically, must support efficient **metadata filtering** at the database level. Without this, combining a semantic vector search with a structured filter (e.g., `source: 'github' AND author: 'justinvdm'`) would require a slow, inefficient, and costly two-step process: first fetch a large number of vector results, then filter them in application code. This led to the selection of Cloudflare Vectorize, which supports metadata filtering directly in the query.

### 2. Accommodating Heterogeneous Data Sources

Each data source-from GitHub issues to Discord conversations-has its own unique structure, metadata, and semantics. The system must be able to understand and process these differences to build a coherent, searchable index. Hardcoding source-specific logic into the engine's core would create a monolithic and unmaintainable system. Therefore, the architecture required a design that decouples the core indexing and querying logic from the specifics of each data source. This is solved by a **plugin-based architecture**, which allows new sources to be added without modifying the engine itself.

### 3. Maintaining a Complete and Fresh Index

The information in our data sources is constantly changing. New issues are created, PRs are updated, and conversations evolve. The index must reflect these changes in a timely manner without requiring a full, costly re-indexing of all documents. The challenge is to efficiently detect and process only what has changed since the last update.

### 4. Decoupling Query Logic from Storage Schema

An early implementation of the context reconstruction logic relied on parsing the R2 object key (`documentId`) to determine the type of document it was and how to format it. This created a brittle, implicit contract between the file storage layout and the query-side logic. A change in the R2 path structure would break the query engine, tightly coupling concerns that should be separate.

### 5. Maintaining Index Synchronization on Document Updates

When a source document is updated (e.g., a new comment is added to a GitHub PR), the vector index must be updated. A naive implementation that simply inserts new vectors would leave the old, stale vectors in the index. This "index pollution" degrades the quality of search results over time by providing outdated and contradictory context to the LLM. The system requires an atomic "delete-then-insert" operation, but a key challenge is efficiently identifying which vectors to delete without performing slow and costly queries.

### 6. Ensuring Index Freshness and Completeness

Relying solely on real-time events (like an R2 object-create event) to trigger indexing is not robust. Events can be missed during outages or high load, leading to parts of the knowledge base never being indexed. The system needs a reliable, systematic process to periodically scan the entire data source and ensure that every document is correctly represented in the vector index.

## The Architecture

The architecture is a plugin-driven pipeline for indexing and querying, designed specifically to solve the challenges above.

### 1. The Plugin System

To solve for extensibility, the engine's core is a hook-based plugin system. The engine orchestrates the data flow, and plugins provide the source-specific implementation details for each stage. The engine uses different composition strategies (First-Match, Waterfall, Collector) to combine the outputs of multiple plugins for a given hook, providing predictable control over the pipeline.

### 2. The Two-Stage Query Pipeline for Context Assembly

To solve the challenge of reconstructing coherent context, the query pipeline is separated into two distinct stages:

*   **Stage 1: Reconstruct Context (`reconstructContext` hook)**: In this stage, the engine first groups search results by their parent document. For each document, it calls the appropriate plugin, whose sole responsibility is to take the full source JSON and the relevant chunks and format them into a single, self-contained, readable block (e.g., a markdown representation of a PR and all its comments).
*   **Stage 2: Aggregate Contexts (`composeLlmPrompt` hook)**: The engine then collects these pre-formatted blocks and passes them to the `composeLlmPrompt` hook. This hook's responsibility is **aggregation**. It can simply join the blocks, or a more advanced plugin could use the rich metadata preserved from Stage 1 to re-order the blocks chronologically, creating a unified narrative from multiple sources.

### 3. Explicit, Namespaced Metadata

To decouple query logic from the storage schema, the system uses an explicit metadata contract. A generic `sourceMetadata` field exists on each chunk's metadata. At indexing time, a plugin populates this field with a structured object containing explicit identifiers (e.g., `{ type: 'github-pr-issue', owner: '...', number: 123 }`). At query time, the `reconstructContext` hook reads directly from this structured object.

### 4. The "Delete-Then-Insert" Strategy via State Tracking

To maintain index synchronization efficiently, the engine uses a stateful "delete-then-insert" strategy. Instead of querying Vectorize to find old vectors, the system tracks the state of the index in a separate Durable Object.

1.  **Store Vector IDs**: After a document is successfully indexed, the engine stores the list of all generated vector IDs (`chunk_ids`) in a state database, associated with the document's R2 key and ETag.
2.  **Delete by ID**: When a document is re-indexed, the engine first retrieves the list of old `chunk_ids` from the state database. It then issues a direct `deleteByIds()` call to Vectorize, which is highly efficient.
3.  **Insert New Vectors**: Only after the old vectors are purged does it insert the new ones and update the state database with the new list of `chunk_ids`.

### 5. The "Scan and Compare" Cron Job for Index Freshness

To ensure the index is always complete, a cron-triggered worker periodically scans the R2 bucket. For each document, it compares its ETag against the one stored in the indexing state database. If the document is missing from the state or the ETags don't match, it's enqueued for indexing. This makes the system resilient, guaranteeing that any missed events or failed jobs are automatically corrected.

## The Anatomy of a Plugin

A plugin is a JavaScript object that provides implementations for one or more hooks. The engine calls these hooks at specific points in the indexing and querying pipelines.

### Composition Strategies

The engine uses one of three strategies to handle hooks that are implemented by multiple plugins:

*   **`First-Match`**: The engine invokes plugins in order until one returns a non-null value. This is for source-specific logic where only one plugin should act.
*   **`Waterfall`**: The output of one plugin becomes the input for the next, creating a sequential chain of transformations.
*   **`Collector`**: The engine invokes all plugins and collects their results into an array. This is for situations where multiple plugins need to contribute.

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
