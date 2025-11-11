# RAG Engine POC: A Quick Walkthrough

Here's a quick look at the RAG engine POC we've been working on. The goal is to share the thinking behind it, the problems we've hit, and how we've tried to solve them.

## 1. The Idea: An "Org AI"

The core idea is to build an internal "organization AI" that can ingest our knowledge from places like GitHub, Cursor chats, and meeting notes. The goal is to make institutional knowledge searchable so we can ask it questions and get context on past decisions.

## 2. Challenges

*   **Vector Search in a Serverless Environment**: Any vector database we use has to work within the constraints of a serverless environment. This means it must scale beyond a single worker's memory limits and, critically, support efficient metadata filtering at the database level. Without that, combining a semantic search with a filter (e.g., `source: 'github'`) would be slow and inefficient.
*   **Handling Different Data Sources**: GitHub issues, PRs, and Cursor chats all have different shapes. We need a solution where we can define how to process (chunk/index), query, filter, and rank differently for each of these sources
*   **Assembling Coherent Context**: A query might return chunks from a PR body, several comments, and a related issue. Simply concatenating them doesn't produce a good prompt. We need a way to reconstruct a readable, logical narrative from these disparate pieces, in a way that filters out parts irrelevant to the query
*   **Atomic Updates**: Source documents are constantly changing. When a document is updated, all of its old chunks must be removed from the index as the new ones are added. This requires an atomic "upsert" or "delete-then-insert" operation for a group of vectors tied to a single document, a feature that isn't always straightforward in vector databases.
*   **Extensibility for Experimentation**: The "best" way to get good RAG results isn't a solved problem. We need the ability to easily experiment with different strategies for chunking, metadata enrichment (like adding topics), and ranking without rewriting the core engine.
*   **Keeping the Index Fresh**: Data changes constantly. A real-time event system alone can miss updates during an outage, while constantly scanning thousands of files is inefficient and hits platform limits. We need a robust strategy for both bulk backfills and real-time updates.

## 3. The High-Level Flow

The system is split into two main pipelines: **Indexing** (getting data in) and **Querying** (getting answers out). The key idea is that a central **engine** runs these pipelines, and **plugins** provide the logic for handling specific data sources.

**Indexing Flow:**
`R2 File` -> `Plugin: prepareSourceDocument` -> `Document` -> `Plugin: splitDocumentIntoChunks` -> `Chunks` -> `Vectorize`

**Querying Flow:**
`User Query` -> `Vector Search` -> `Chunk Metadata` -> `Plugin: reconstructContext` -> `Formatted Context` -> `Plugin: composeLlmPrompt` -> `LLM`

---

## 4. Anatomy of a Plugin

A plugin is just a JavaScript object with functions called **hooks**. The engine calls these hooks at specific points in the pipeline to do the source-specific work.

Here’s a simplified skeleton of our `GitHubPlugin`:
```typescript
const GitHubPlugin = {
  name: "GitHubPlugin",

  // --- INDEXING HOOKS ---
  prepareSourceDocument: (r2Key, fileBody) => { /* ... */ },
  splitDocumentIntoChunks: (document) => { /* ... */ },

  // --- QUERYING HOOKS ---
  reconstructContext: (chunks, fullDocument) => { /* ... */ },
};
```
Now let's see how these hooks are used in the real flow.

---

## 5. The Indexing Flow in Detail

Let's trace a GitHub issue from a raw file to a searchable vector.

#### Step 1: A file is updated in R2

The process starts when the GitHub ingestor saves an issue as a structured `latest.json` file in R2.

The guiding principle here is simple: give the AI context the same way a human gets it. A human reads the whole GitHub page—the issue and all its comments—to understand the full picture. By creating a complete, denormalized snapshot in `latest.json`, we do the hard work of assembling that context upfront. This avoids forcing the RAG engine to perform complex, slow 'stitching' of related data during a query, a process that is not only inefficient but also risks losing the semantic relationship between the pieces when the data is in the form of flattened, vectorized chunks+metada representation.

While it represents a full page, we use JSON instead of a flat Markdown file so we can easily slice it up. The structured format allows the engine to treat the issue body and each individual comment as distinct chunks for indexing. Later, during a query, the engine can intelligently reconstruct the context from these pieces, with the added power of **filtering out chunks that are irrelevant** to the user's question.

Any time a comment is added or the issue's description is edited, the ingestor completely overwrites this `latest.json` file with the new, full state of the issue. This overwrite action in R2 is the event that kicks off the re-indexing process, ensuring the engine is always working with the latest version.

*   **`github/redwoodjs/machinen/issues/42/latest.json`**
    ```json
    {
      "title": "Scanner is hitting API limits",
      "body": "The cron-based scanner is making too many calls...",
      "comments": [
        { "author": "userA", "body": "Have we considered event-driven?" },
        { "author": "userB", "body": "Good idea. R2 events could work." }
      ]
    }
    ```

#### Step 2: `prepareSourceDocument` Hook

An R2 event fires, and the engine starts the indexing pipeline. It calls the first hook. The `GitHubPlugin` recognizes the `github/` prefix and transforms the raw JSON into a standardized **`Document`** object.

The `Document` object's `content` field is intentionally simple, containing just the main body of the issue. The source-specific details, like comments, are handled in the next step. The plugin has the `document.id` (the R2 key) so it can always get the full original JSON when it needs it.

*   **Plugin Hook**: `GitHubPlugin.prepareSourceDocument`
*   **Output**: A `Document` object. This normalizes the data for the rest of the pipeline.
    ```js
    {
      id: "github/.../issues/42/latest.json",
      content: "The cron-based scanner is making too many calls...",
      source: "github",
      metadata: { title: "Scanner is hitting API limits" }
    }
    ```

#### Step 3: `splitDocumentIntoChunks` Hook

Next, the engine needs to break the `Document` into smaller pieces for vector search. It calls the next hook. The `GitHubPlugin` splits the document's body and its comments into separate **`Chunk`** objects.

*   **Plugin Hook**: `GitHubPlugin.splitDocumentIntoChunks`
*   **Output**: An array of `Chunk` objects. Each chunk's metadata includes a `chunkId` for unique identification and a **`jsonPath`**, a precise pointer to where its content lives in the original `latest.json` file.
    ```js
    [
      {
        content: "The cron-based scanner is making too many calls...",
        metadata: {
          type: "issue-body",
          chunkId: "github/.../issues/42/latest.json#body",
          jsonPath: "$.body"
        }
      },
      {
        content: "Have we considered event-driven?",
        metadata: {
          type: "issue-comment",
          author: "userA",
          chunkId: "github/.../issues/42/latest.json#comment-0",
          jsonPath: "$.comments[0].body"
        }
      },
      {
        content: "Good idea. R2 events could work.",
        metadata: {
          type: "issue-comment",
          author: "userB",
          chunkId: "github/.../issues/42/latest.json#comment-1",
          jsonPath: "$.comments[1].body"
        }
      }
    ]
    ```

#### Step 4: Storing in Vectorize

The engine hands these chunks back to the worker. The worker generates an embedding for each chunk's `content` and stores it in Vectorize. For each vector, we store its rich metadata object. This metadata is the "pointer" that allows us to find the original content during a query.

*Here's what the metadata for the first comment vector would look like:*
```js
// Stored in Vectorize alongside the embedding
{
  "documentId": "github/redwoodjs/machinen/issues/42/latest.json",
  "chunkId": "github/redwoodjs/machinen/issues/42/latest.json#comment-0",
  "source": "github",
  "documentTitle": "Scanner is hitting API limits",
  "type": "issue-comment",
  "author": "userA",
  "jsonPath": "$.comments[0].body"
}
```

---

## 6. The Query Flow in Detail

Now, let's see what happens when a user asks: *"how did we fix the scanner api limits?"*

#### Step 1: Vector Search

The engine queries Vectorize and gets back a ranked list of the most relevant **`ChunkMetadata`** objects. These are just the pointers; they don't contain the text content itself.

*   **Output**: A list of metadata objects.
    ```js
    [
      {
        "documentId": "github/.../issues/42/latest.json",
        "chunkId": "github/.../issues/42/latest.json#comment-0",
        "jsonPath": "$.comments[0].body",
        "type": "issue-comment",
        "author": "userA",
        "score": 0.91
      },
      {
        "documentId": "github/.../issues/42/latest.json",
        "chunkId": "github/.../issues/42/latest.json#body",
        "jsonPath": "$.body",
        "type": "issue-body",
        "score": 0.88
      }
    ]
    ```

#### Step 2: `reconstructContext` Hook

This is where we solve the "assembling coherent context" challenge. The engine groups these results by document and calls the `reconstructContext` hook.

The `GitHubPlugin` receives the full original JSON and the list of relevant chunks' metadata. It can now make smart decisions. It uses the `jsonPath` from each chunk's metadata to extract the precise content from the JSON. This is also where it can choose to **filter out irrelevant information**, for example by ignoring chunks that didn't show up in the search results, and then formats the extracted content into a readable narrative.

*   **Plugin Hook**: `GitHubPlugin.reconstructContext`
*   **Output**: The hook returns a `ReconstructedContext` object. The example below shows the formatted string from the `content` property of that object.
    ```markdown
    ## From GitHub Issue #42: Scanner is hitting API limits

    **Issue Body:**
    The cron-based scanner is making too many calls...

    **Comment from @userA:**
    Have we considered event-driven?
    ```

#### Step 3: `composeLlmPrompt` Hook

The engine gathers all the formatted context blocks (there might be several from different documents) and passes them to a final plugin to create the prompt for the LLM.

*   **Plugin Hook**: `DefaultPlugin.composeLlmPrompt`
*   **Output**: The final prompt string.
    ```
    Based on the following context, answer the user's question.

    Context:
    ---
    ## From GitHub Issue #42: Scanner is hitting API limits

    **Issue Body:**
    The cron-based scanner is making too many calls...

    **Comment from @userA:**
    Have we considered event-driven?
    ---

    Question:
    how did we fix the scanner api limits?
    ```

This final prompt is sent to the LLM to generate the answer.

## 7. What next:

Now that the core plugin-driven engine is in place, we can easily experiment with different strategies to improve the results. Some ideas:
*   **Support More Data Sources**: Write plugins for other data sources (Cursor, Discord).
*   **Experiment with a `TopicsPlugin`**: Introduce "topics" via a plugin as a way to improve search accuracy.
    *   **Indexing**: A plugin's `enrichChunk` hook could be used to analyze each chunk and tag it with relevant topics (e.g., "SSR," "database," "authentication").
    *   **Querying**: At query time, another hook could use these topics to either pre-filter the search or to boost the relevance of chunks that match the query's topic.
*   **Build a UI**: A simple chat interface would make it easier to run these experiments and use the system.