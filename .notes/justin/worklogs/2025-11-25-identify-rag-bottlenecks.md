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
*   **Parallelize R2 Fetches**: Fetch all 45 documents concurrently using `Promise.all()` instead of sequential `for...of` loop. This could reduce context reconstruction from ~10.4s to ~300-400ms (limited by slowest fetch). [Implemented]
*   **Consider Caching**: If documents don't change frequently, consider caching fetched documents in memory or a faster cache layer.
*   **Reduce Context Size**: The prompt is 71,055 chars. Consider more aggressive context optimization to reduce LLM generation time.

## Implementation: Parallel R2 Fetches

Refactored `reconstructContexts()` to fetch all documents concurrently:
*   Changed from sequential `for...of` loop to `Promise.all()` with parallel fetches
*   All R2 fetches now happen concurrently instead of one-by-one
*   Added summary log showing total time for all fetches combined
*   Individual fetch timings still logged for monitoring

Expected impact: Context reconstruction should drop from ~10.4s to ~300-400ms (limited by slowest individual fetch), reducing total query time from ~22s to ~12s.

## LLM Model Switch: GPT-OSS-20B

### Research Findings
Based on benchmarks from [artificialanalysis.ai](https://artificialanalysis.ai/?models=gpt-oss-120b%2Cgpt-oss-20b%2Cllama-4-scout%2Cgemma-3-27b%2Cgemma-3-12b&speed=speed#output-speed):
*   `@cf/openai/gpt-oss-20b` shows comparable speed to GPT 5.1
*   Significantly faster than Gemma models
*   Fraction of the cost of GPT 5.1
*   20B parameters should be sufficient for RAG tasks (vs 120B)

### Implementation
*   Switched from `@cf/google/gemma-3-12b-it` to `@cf/openai/gpt-oss-20b`
*   Model location: `src/app/engine/engine.ts:435`

### Expected Impact
*   Current LLM generation: 10,153ms (46% of total query time)
*   With faster model: Potentially 30-50% reduction in generation time
*   Combined with parallel R2 fetches: Total query time could drop from ~22s to ~7-9s

### Next Steps
*   Test with real queries to measure actual performance improvement
*   Monitor response quality to ensure it meets requirements
*   Compare against baseline metrics from out.log

## R2 Concurrent Request Limit Issue

### Problem
After implementing parallel R2 fetches, encountered warning:
> "A stalled HTTP response was canceled to prevent deadlock. This can happen when a Worker calls fetch() several times without reading the bodies of the returned Response objects. There is a limit on the number of concurrent HTTP requests that can be in-flight at one time."

### Research Findings
*   **R2 does NOT support batch fetches**: Each object must be fetched individually via `bucket.get()`
*   **Cloudflare Workers limit**: **6 simultaneous open connections** per invocation (not 50!)
*   **Subrequest limit**: 50-1000 depending on plan, but connection limit is the bottleneck
*   **Issue**: Fetching 45 documents in parallel tried to open 45 connections, but limit is only 6, causing stalled requests

### Solution: Batched Parallel Fetches
Implemented batching to respect the simultaneous connection limit:
*   Process R2 fetches in batches of 6 (staying under the connection limit)
*   Each batch runs in parallel with `Promise.all()`
*   Batches execute sequentially to avoid exceeding limits
*   Added batch-level logging for monitoring

### Implementation
*   Modified `reconstructContexts()` to batch fetches
*   Batch size: 6 concurrent requests (CONCURRENT_FETCH_LIMIT)
*   For 45 documents: 8 batches (45 ÷ 6 = 7.5, rounds to 8 batches)
*   Each batch processes 6 documents in parallel, then moves to next batch

### Expected Impact
*   Avoids deadlock warnings by respecting 6-connection limit
*   Still maintains parallelization benefits (6x faster than sequential per batch)
*   For 45 documents: ~1.5-2s (8 batches × ~200-250ms per batch)
*   Much faster than sequential (~10s), but slower than unlimited parallel (~300ms)
*   This is the best we can do within Cloudflare Workers constraints
