# RAG Engine POC: A Quick Walkthrough

Here's a quick look at the RAG engine POC we've been working on. The goal is to share the thinking behind it, the problems we've hit, and how we've tried to solve them.

## 1. The Idea: An "Org AI"

The core idea is to build an internal "organization AI" that can ingest our knowledge from places like GitHub, Cursor chats, and meeting notes. The goal is to make institutional knowledge searchable so we can ask it questions and get context on past decisions.

## 2. Challenges

*   **Vector Search in a Serverless Environment**: Any vector database we use has to work within the constraints of a serverless environment. This means it must scale beyond a single worker's memory limits and, critically, support efficient metadata filtering at the database level. Without that, combining a semantic search with a filter (e.g., `source: 'github'`) would be slow and inefficient.
*   **Handling Different Data Sources**: GitHub issues, PRs, and Cursor chats all have different shapes. We need a solution where we can define how to process (chunk/index), query, filter, and rank differently for each of these sources
*   **Assembling Coherent Context**: A query might return chunks from a PR body, several comments, and a related issue. Simply concatenating them doesn't produce a good prompt. We need a way to reconstruct a readable, logical narrative from these disparate pieces, in a way that filters out parts irrelevant to the query
*   **Atomic Updates**: Source documents are constantly changing. When a document is updated, all of its old chunks must be removed from the index as the new ones are added. This requires an atomic "upsert" or "delete-then-insert" operation for a group of vectors tied to a single document, a feature that isn't always straightforward in vector databases.
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
*   **Output**: An array of `Chunk` objects.
    ```js
    [
      {
        content: "The cron-based scanner is making too many calls...",
        metadata: { type: "issue-body" }
      },
      {
        content: "Have we considered event-driven?",
        metadata: { type: "issue-comment", author: "userA" }
      },
      {
        content: "Good idea. R2 events could work.",
        metadata: { type: "issue-comment", author: "userB" }
      }
    ]
    ```

#### Step 4: Storing in Vectorize

The engine hands these chunks back to the worker. The worker generates an embedding for each chunk's `content` and stores it in Vectorize. The crucial part is that the **metadata** for each chunk is stored alongside its vector. This metadata acts as a "pointer" back to the original source.

---

## 6. The Query Flow in Detail

Now, let's see what happens when a user asks: *"how did we fix the scanner api limits?"*

#### Step 1: Vector Search

The engine queries Vectorize and gets back a ranked list of the most relevant **`ChunkMetadata`** objects. These are just the pointers; they don't contain the text content itself.

*   **Output**: A list of metadata objects.
    ```js
    [
      {
        documentId: "github/.../issues/42/latest.json",
        chunkId: "...#comment-0",
        type: "issue-comment",
        author: "userA",
        score: 0.91
      },
      {
        documentId: "github/.../issues/42/latest.json",
        chunkId: "...#body",
        type: "issue-body",
        score: 0.88
      }
    ]
    ```

#### Step 2: `reconstructContext` Hook

This is where we solve the "assembling coherent context" challenge. The engine groups these results by document and calls the `reconstructContext` hook.

The `GitHubPlugin` receives the chunks for Issue #42 and the full original JSON. It can now make smart decisions. It can format the body and comments into a readable narrative, and crucially, **it can choose to filter out irrelevant information**. For example, it could decide to only include comments above a certain relevance score.

*   **Plugin Hook**: `GitHubPlugin.reconstructContext`
*   **Output**: A single formatted string of context.
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

## 7. Where We Are & What's Next

Right now, the engine is working well for the GitHub data source. The event-driven indexing is handling updates, and the query results seem relevant.

Some ideas for what could be next:
*   **Onboard More Data Sources**: We could write plugins for Cursor conversations or meeting notes.
*   **Build a UI**: A simple chat interface would make this much easier to use.
*   **Experiment with Advanced Plugins**: We could try more sophisticated ideas, like plugins that rerank search results or create more dynamic, narrative-style prompts.
