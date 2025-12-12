# Knowledge Synthesis Engine Architecture

The Knowledge Synthesis Engine is the subsystem responsible for the "Knowledge Graph" tier of the application. While the Evidence Locker (RAG) handles factual retrieval ("what"), this engine handles narrative retrieval ("why" and "how"). It constructs a **Moment Graph** from raw data sources to answer complex questions about the evolution of a codebase or project.

## The Challenges

### 1. The "Tree-Shaking" Problem: Connecting Contextual Dots
In a complex project, the solution to a problem often looks nothing like the problem itself. A discussion might start with "Tree-shaking is broken" (Problem) and end weeks later with "Implemented barrel files" (Solution). A traditional RAG system sees these as semantically unrelated chunks. Without a way to capture the *causal* link between these events—the "story" of how we got from A to B—the system cannot answer "Why did we implement barrel files?".

### 2. The Signal-to-Noise Ratio in Raw Logs
Source data, especially chat logs (Cursor, Discord), is extremely noisy. A single logical "moment" (e.g., "Debugging the auth service") might span 50 back-and-forth exchanges of "try this", "didn't work", "oops typo". Feeding this raw stream into an LLM for every query is costly, slow, and often confuses the model with irrelevant details. The system needs a way to filter out the noise and persist only the *signal*—the turning points and decisions.

### 3. The "Historian's Dilemma": Synthesis vs. Retrieval
Retrieving raw chunks is not enough to tell a story. A list of 50 commit messages or chat logs does not constitute a narrative. To answer "How did the architecture evolve?", the system must act as a historian: it needs to *synthesize* raw events into a coherent narrative *before* query time. Doing this synthesis on-the-fly for every query is prohibitively expensive and slow.

### 4. Efficiently Processing Evolving Conversations
Conversations evolve. An older part of a thread might remain static while new messages are added. Re-processing and re-summarizing the entire conversation for every new message is wasteful. The system requires a granular caching strategy that can recognize unchanged parts of a conversation to minimize LLM costs and latency.

## The Architecture

The solution is a graph-based architecture that creates a layer of abstraction between raw data and queryable knowledge.

### 1. The Moment Graph
Instead of a flat list of documents, we model knowledge as a graph of **Moments**.
*   **Moments (Macro-Moments)**: The nodes of the graph. These are high-level, synthesized events (e.g., "Identified root cause in router", "Decided to switch databases"). They contain rich, LLM-generated summaries, not raw text.
*   **Subjects (Root Moments)**: The entry points of the graph. A Subject is simply a Moment with no parent. It defines the start of a topic or stream of work.
*   **Edges**: Represent chronological and causal relationships. By traversing from a Subject down its descendants, we can reconstruct the full timeline of a story.

### 2. The "Segmentation and Synthesis" Pipeline
To solve the signal-to-noise problem, ingestion is split into two distinct phases:

*   **Phase 1: Segmentation (Micro-Moments)**
    The system first breaks raw documents down into **Micro-Moments**—atomic units of raw data (e.g., a single user/assistant exchange, a GitHub comment). These represent the raw "evidence" without judgement.

*   **Phase 2: Synthesis (Macro-Moments)**
    The engine then passes the stream of Micro-Moments to an LLM acting as a "Historian." This model analyzes the sequence to:
    1.  **Filter**: Discard irrelevant chatter.
    2.  **Cluster**: Group related Micro-Moments into logical events.
    3.  **Synthesize**: Generate a **Macro-Moment** for each group, writing a concise title and a rich summary that captures the *narrative significance* (the "why").

### 3. Micro-Moments as a Universal Cache
To solve the efficiency problem, **Micro-Moments** serve a dual purpose: they are both the raw input for synthesis and the unit of caching.

The Engine relies on two distinct Plugin hooks to achieve this optimization: `extractMicroMomentsFromDocument` (cheap, deterministic) and `summarizeMomentContent` (expensive, on-demand).

*   **Step 1: Extraction (Cheap)**: The engine calls `extractMicroMomentsFromDocument`. The plugin simply identifies raw units (e.g., "Message ID 123") and returns them. No AI is used here.
*   **Step 2: Cache Check**: For each extracted item, the engine checks its database using the composite key `(documentId, path)`.
    *   **Hit**: The engine finds an existing Micro-Moment. It reuses the **cached summary and embedding**, skipping the expensive AI operations.
    *   **Miss**: The engine calls the plugin's `summarizeMomentContent` hook (which calls the LLM), generates an embedding, and stores the result.

This architecture ensures that we only pay the "AI Tax" for new or modified content, while allowing the system to incrementally process evolving documents (like long chat threads) efficiently.

### 4. Subject-First Narrative Querying
To answer "why" questions, the query engine flips the traditional RAG model:
1.  **Find the Subject**: Instead of searching for keywords, it first searches the **Subject Index** (root moments) to find the broad topic matching the user's intent.
2.  **Reconstruct the Timeline**: Once a Subject is identified, the engine traverses the graph to retrieve all descendant Moments, effectively loading the entire "chapter" of the story.
3.  **Synthesize Answer**: The LLM is given this full, curated narrative timeline (not random chunks) to generate a coherent answer.

## Integration with the Evidence Locker

The Knowledge Synthesis Engine operates alongside the traditional Evidence Locker (RAG) to provide a complete picture.

### Ingestion: Parallel Processing
When a document is indexed, it undergoes two parallel processes:
1.  **Evidence Locker Path**: The document is split into raw `Chunks`, hashed for deduplication, and indexed into the vector database for precise factual retrieval.
2.  **Knowledge Graph Path**: The document is analyzed for `Micro-Moments`, synthesized into `Macro-Moments`, and woven into the narrative graph for high-level understanding.

### Querying: The Narrative Waterfall
The query engine employs a waterfall strategy to answer questions:
1.  **Attempt Narrative Query**: First, the system tries to match the query to a `Subject` in the Moment Graph. If a relevant Subject is found, it constructs a narrative answer from the timeline.
2.  **Drill-Down (Future Work)**: In future iterations, the system will use the found Moments to precisely filter the Evidence Locker. Instead of a broad semantic search, we can fetch the exact raw chunks (Micro-Moments) that back up a specific point in the narrative, allowing the user to "double-click" on a summary to see the source truth.
3.  **Fallback to Evidence Locker**: If no relevant Subject is found, or if the query is purely factual/specific (e.g., "what was the error code"), the system falls back to the standard RAG pipeline, retrieving specific `Chunks` to generate an answer.

## Data Flow

1.  **Ingestion**: `Raw Doc` -> `Plugin` ->
    *   *Path A (Narrative)*: `Micro-Moments` -> `Cache Check` -> `Synthesis (LLM)` -> `Macro-Moments` -> `Graph Storage`
    *   *Path B (Evidence)*: `Chunks` -> `Deduplication` -> `Vector Storage`
2.  **Query**: `User Query` -> `Subject Search` ->
    *   *Match Found*: `Graph Traversal` -> `Timeline Assembly` -> `LLM Generation`
    *   *No Match*: `Vector Search (Evidence)` -> `Context Assembly` -> `LLM Generation`
