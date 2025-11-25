# 2025-11-25 - Identify RAG Engine Bottlenecks

## Problem
The user wants to identify bottlenecks in the current RAG engine implementation. The system is built on Cloudflare Workers, utilizing R2 and Vectorize. We need a fast way to determine where the latency lies (e.g., vector search, LLM generation, data processing).

## Plan
1.  **Analyze Existing Code**: Examine `src/app/engine/engine.ts` and related files to see if any performance logging or timing metrics already exist. [Completed]
2.  **Identify Key Stages**: Based on the `2025-11-11-rag-engine-walkthrough.md`, the key stages are:
    *   Indexing: `prepareSourceDocument`, `splitDocumentIntoChunks`, Vectorize insertion.
    *   Querying: Vector Search, `reconstructContext`, `composeLlmPrompt`, LLM generation.
3.  **Propose Instrumentation**: If no timing exists, add simple logging (start/end timestamps) around these key stages. [Completed]
4.  **Utilization of Scripts**: Use existing scripts like `scripts/tail-logs.sh` to observe these metrics in real-time. [Completed]

## Changes
*   Modified `src/app/engine/engine.ts` to include `Date.now()` based timing logs around all major steps in `query`, `indexDocument`, `performVectorSearch`, `reconstructContexts`, `generateEmbedding`, and `callLlm`.

## Findings
*   Existing logging was verbose but lacked duration metrics.
*   Added logs will output `[query] Step X took Yms` and `[engine] ... took Yms` which can be easily filtered or viewed via `tail-logs.sh`.

## Performance Analysis (from out.log)

### Query Breakdown (Total: 21,936ms)
*   **Vector Search Execution**: 1,402ms (6.4%)
    *   Embedding generation: 276ms
    *   Vectorize query: 1,126ms
*   **Context Reconstruction**: 10,381ms (47.3%) ← **Primary Bottleneck**
    *   45 sequential R2 fetches
    *   Average per fetch: 230ms
    *   Total R2 fetch time: 10,368ms
    *   Plugin processing: ~13ms (negligible)
*   **LLM Generation**: 10,153ms (46.3%) ← **Secondary Bottleneck**
*   **Other Steps**: <1ms each (query prep, filter build, reranking, prompt composition, formatting)

### Key Insights
1.  **Sequential R2 Fetches**: The largest bottleneck is fetching 45 documents sequentially from R2. Each fetch averages 230ms, totaling 10.4 seconds. This is nearly half the total query time.
2.  **LLM Generation**: At 10.1 seconds, LLM generation is the second-largest time consumer, but this is expected for large prompts (71,055 chars).
3.  **Vector Search**: Vectorize query performance is reasonable at 1.1 seconds for 50 results.

### Recommendations
*   **Parallelize R2 Fetches**: Fetch all 45 documents concurrently using `Promise.all()` instead of sequential `for...of` loop. This could reduce context reconstruction from ~10.4s to ~300-400ms (limited by slowest fetch).
*   **Consider Caching**: If documents don't change frequently, consider caching fetched documents in memory or a faster cache layer.
*   **Reduce Context Size**: The prompt is 71,055 chars. Consider more aggressive context optimization to reduce LLM generation time.
