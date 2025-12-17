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
*   **Edges**: Represent chronological and causal relationships. A single Subject can have multiple branches when later documents attach under non-root Moments.

### 2. The "Segmentation and Synthesis" Pipeline
To solve the signal-to-noise problem, ingestion is split into two distinct phases:

*   **Phase 1: Segmentation (Micro-Moments)**
    The system first breaks raw documents down into **Micro-Moments**—atomic units of raw data (e.g., a single user/assistant exchange, a GitHub comment). These represent the raw "evidence" without judgement.

    This process is engine-owned but source-aware:
    *   **Per-chunk attribution**: The engine normalizes actor attribution (e.g., `@handle`) from chunk metadata so the LLM knows exactly who said what.
    *   **Narrative context**: Plugins provide a "lens" (via `getMicroMomentBatchPromptContext`) to guide summarization (e.g., "Treat these GitHub issue chunks as a proposal, not completed work").

*   **Phase 2: Synthesis (Macro-Moments)**
    The engine then passes the stream of Micro-Moments to an LLM acting as a "Historian." This model analyzes the sequence to:
    1.  **Filter**: Discard irrelevant chatter.
    2.  **Cluster**: Group related Micro-Moments into logical events.
    3.  **Synthesize**: Generate a **Macro-Moment** for each group, writing a concise title and a rich summary that captures the *narrative significance* (the "why").

    Plugins enrich this step via the `getMacroSynthesisPromptContext` hook, which provides:
    *   **Formatting rules**: Instructions for source labels in titles (e.g., `[GitHub Issue #552]`).
    *   **Reference context**: Canonical tokens to be included in the summary text.

*   **Phase 3: Correlation (Smart Linker)**
    Before persisting, the engine attempts to stitch the new Macro-Moments into existing timelines.
    1.  **Search**: It queries the vector index for existing Moments that match the semantic content of the new document.
    2.  **Attach**: If a strong match is found, the new document's timeline attaches as a branch under the existing Moment.
    3.  **Root**: If no match is found, the new timeline starts a new Subject (Root Moment).

### 3. Canonical references in macro moments (source labels and tokens)
Macro moments are summaries, but they also need a lightweight way to identify where they came from. The system uses two layers:

- A human-readable source label in the title (example: `[GitHub Pull Request]`, `[Discord Thread]`).
- A canonical reference token embedded in the summary near the first mention of the source entity.

Canonical reference tokens are intended to be short, parseable, and unique. The format is:

- `mchn://<source>/<type>/<path>`

Example shapes:

- `mchn://gh/issue/<owner>/<repo>/<number>`
- `mchn://gh/pr/<owner>/<repo>/<number>`
- `mchn://dc/thread/<guildid>/<channelid>/<threadid>`
- `mchn://dc/thread_message/<guildid>/<channelid>/<threadid>/<messageid>`

The current approach is prompt-driven: the macro synthesis prompt includes specific formatting rules and reference context provided by the plugin, so the LLM deterministically includes the correct label and token in the output.

### 3. Micro-Moments as a Universal Cache
To solve the efficiency problem, **Micro-Moments** serve a dual purpose: they are both the raw input for synthesis and the unit of caching.

The Engine relies on chunking for a source-agnostic input stream and engine-owned micro-moment caching, while allowing plugins to tailor summarization prompts per source.

There are two caching layers:

*   **Chunk-diff caching (document chunk hashes)**: On re-index, the engine compares current chunk hashes against the previous run and skips any unchanged chunks. This avoids re-enqueueing unchanged evidence chunks and avoids recomputing micro-moment batches that would be identical.
*   **Micro-moment batch caching (batch hash)**: For the chunks that remain, the engine computes a batch hash for each chunk batch and reuses cached micro-moment summaries and embeddings when the batch hash matches a previously computed batch.

*   **Step 1: Chunking (Cheap)**: The engine calls the chunking hook (`splitDocumentIntoChunks`) to produce a stable, ordered list of chunks.
*   **Step 2: Chunk-diff cache check**: The engine compares the chunk hashes for the document against the previously stored hashes. Only new or modified chunks are processed further.
*   **Step 3: Micro-moment computation (Batched)**: The engine batches the remaining chunks for performance (token/size caps), then calls the engine-owned summarizer. This function uses plugin-provided context (`getMicroMomentBatchPromptContext`) to ensure summaries reflect the correct narrative framing (e.g. proposal vs implementation).
*   **Step 4: Micro-moment batch cache check**: Each chunk batch is keyed by a hash of its chunk ids/hashes. On re-index:
    *   **Hit**: reuse cached micro-moment summaries and embeddings for that batch.
    *   **Miss**: recompute only the batches that changed.
*   **Step 5: Synthesis**: The engine synthesizes macro moments from the micro-moment stream.

This architecture ensures that we only pay the "AI Tax" for new or modified content, while allowing the system to incrementally process evolving documents (like long chat threads) efficiently.

### 4. Narrative Querying (Root-to-Leaf Timeline)
To answer "why" questions, the query engine flips the traditional RAG model:

1.  **Find anchor Moments**: The query is embedded and matched against the **Moment Index** (all moments). Each match is treated as an anchor.
2.  **Resolve Root Subject**: For each matched Moment, the engine identifies the root Subject of that timeline.
3.  **Retrieve Descendant Timeline**: The engine retrieves the *full descendant timeline* under that root. This ensures that linked work (e.g., a Discord thread attached to a GitHub issue) is included in the context, even if the query matched the parent issue and not the thread.
4.  **Synthesize Answer**: The LLM is given this full timeline—formatted with ISO8601 timestamps and canonical references—to generate an answer grounded in the chronological narrative.

#### Narrative Context
The context provided to the LLM is a chronological list of macro-moments, ordered by their timestamp (derived from the underlying micro-moments). Each line includes:
- ISO8601 timestamp
- Source label and Title
- Summary with canonical reference tokens

This allows the model to reason about the sequence of events without inventing dates or hallucinations.

### 5. Moment Graph namespaces (test isolation)
During development, it is sometimes useful to run repeated ingestion experiments without deleting existing data in Durable Objects or Vectorize. The Moment Graph supports a namespace value that scopes both storage and retrieval.

- Durable Object storage uses the namespace value as a prefix for the database name.
- Moment and subject vectors store the namespace value in vector metadata.
- Queries for moments and subjects apply a Vectorize metadata filter using the namespace value.

This avoids returning topK results from other namespaces and then dropping them in code after the vector query.

Note: Vectorize metadata filtering requires creating metadata indexes for the filtered keys. Without a metadata index, filtered queries can return empty match sets even when vectors exist with the expected metadata.

## Integration with the Evidence Locker

The Knowledge Synthesis Engine operates alongside the traditional Evidence Locker (RAG) to provide a complete picture.

### Ingestion: Parallel Processing
When a document is indexed, it undergoes two parallel processes:
1.  **Evidence Locker Path**: The document is split into raw `Chunks`, hashed for deduplication, and indexed into the vector database for precise factual retrieval.
2.  **Knowledge Graph Path**: The document is analyzed for `Micro-Moments`, synthesized into `Macro-Moments`, and woven into the narrative graph for high-level understanding.

### Querying: The Narrative Waterfall
The query engine employs a waterfall strategy to answer questions:
1.  **Attempt Narrative Query**: First, the system tries to match the query to a `Moment` in the Moment Graph. If a match is found, it resolves the root Subject and constructs a narrative answer from the full descendant timeline.
2.  **Drill-Down (Future Work)**: In future iterations, the system will use the found Moments to precisely filter the Evidence Locker. Instead of a broad semantic search, we can fetch the exact raw chunks (Micro-Moments) that back up a specific point in the narrative, allowing the user to "double-click" on a summary to see the source truth.
3.  **Fallback to Evidence Locker**: If no relevant Subject is found, or if the query is purely factual/specific (e.g., "what was the error code"), the system falls back to the standard RAG pipeline, retrieving specific `Chunks` to generate an answer.

## Data Flow

1.  **Ingestion**: `Raw Doc` -> `Plugin` ->
    *   *Path A (Narrative)*: `Chunks` -> `Micro-Moments (batched)` -> `Cache Check` -> `Synthesis (LLM)` -> `Macro-Moments` -> `Graph Storage`
    *   *Path B (Evidence)*: `Chunks` -> `Deduplication` -> `Vector Storage`
2.  **Query**: `User Query` -> `Moment Search` ->
    *   *Match Found*: `Resolve Root` -> `Descendant Timeline Assembly` -> `LLM Generation`
    *   *No Match*: `Vector Search (Evidence)` -> `Context Assembly` -> `LLM Generation`
