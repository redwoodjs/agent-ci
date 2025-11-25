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

## Implementation: Immediate Body Reading + Keep-N-In-Flight Pattern

### Problem
Even with batching to 6, still getting warnings. The issue: we weren't reading response bodies immediately, so connections stayed open.

### Solution
Implemented two optimizations:
1. **Immediate body reading**: Read `.text()` immediately after `bucket.get()` to consume connections right away
2. **Keep-N-In-Flight pattern**: Instead of strict batching, keep exactly N requests in flight continuously
   *   As soon as one completes, start the next
   *   No idle time between batches
   *   Maximizes throughput within connection limits

### Implementation Details
*   Created `fetchAndReadDocument()` helper that fetches AND reads body in one operation
*   Uses `Promise.race()` to process completions as they happen
*   Maintains exactly `CONCURRENT_FETCH_LIMIT` (currently 6) requests in flight
*   Configurable limit - easy to test higher values (8, 10, etc.) if immediate reads allow it

### Expected Impact
*   Should eliminate connection warnings (bodies consumed immediately)
*   Better throughput than strict batching (no gaps between batches)
*   For 45 documents: Potentially ~1-1.5s (vs ~1.5-2s with strict batching)
*   Can test increasing `CONCURRENT_FETCH_LIMIT` to 8-10 if no warnings appear

### Next Steps
*   Test with current limit (6) to verify warnings are gone
*   If successful, incrementally test higher limits (8, 10) to find optimal concurrency
*   Monitor logs for any connection-related warnings

## Performance Results Comparison

### Baseline (Before Optimizations)
*   **Total Query Time**: 21,936ms
*   **Vector Search Execution**: 1,402ms (6.4%)
    *   Embedding generation: 276ms
    *   Vectorize query: 1,126ms
*   **Context Reconstruction**: 10,381ms (47.3%)
    *   45 sequential R2 fetches: 10,368ms
    *   Plugin processing: ~13ms
*   **LLM Generation**: 10,153ms (46.3%)
    *   Model: `@cf/google/gemma-3-12b-it`

### After Optimizations
*   **Total Query Time**: 13,342ms (wallTime: 13,343ms)
*   **Vector Search Execution**: 1,586ms (11.9%)
    *   Embedding generation: 604ms
    *   Vectorize query: 982ms
*   **Context Reconstruction**: 3,165ms (23.7%)
    *   45 parallel R2 fetches (6 concurrent): 3,165ms
    *   Plugin processing: ~0ms
*   **LLM Generation**: 8,591ms (64.4%)
    *   Model: `@cf/openai/gpt-oss-20b`

### Performance Improvements
*   **Total Query Time**: **39% faster** (21,936ms → 13,342ms, **8.6s saved**)
*   **Context Reconstruction**: **70% faster** (10,381ms → 3,165ms, **7.2s saved**)
*   **LLM Generation**: **15% faster** (10,153ms → 8,591ms, **1.6s saved**)
*   **Vector Search**: Slightly slower (1,402ms → 1,586ms, +184ms, likely variance)

### Key Wins
1.  **Parallel R2 fetches**: Reduced context reconstruction from 10.4s to 3.2s - the largest improvement
2.  **Faster LLM model**: GPT-OSS-20B is 15% faster than Gemma-3-12B
3.  **No connection warnings**: Immediate body reading + keep-6-in-flight pattern eliminated deadlock warnings
4.  **Overall**: Query time reduced from ~22s to ~13s - nearly **40% improvement**

### Remaining Bottlenecks
*   **LLM Generation**: Still the largest component at 8.6s (64% of total time)
*   **Context Reconstruction**: Down to 3.2s but could potentially be faster with higher concurrency (if limits allow)
*   **Vector Search**: Minor variance, not a concern

## PR Description

### Performance Instrumentation

Added timing logs throughout the query and indexing pipelines. Each major step now logs its execution time, making it easy to spot bottlenecks. Logs include durations for vector search, embedding generation, R2 fetches, context reconstruction, LLM generation, and other pipeline stages.

### Parallel R2 Fetches

Refactored context reconstruction to fetch R2 documents in parallel instead of sequentially. Implemented a keep-6-in-flight pattern that maintains exactly 6 concurrent requests (respecting Cloudflare Workers' connection limit) and reads response bodies immediately to free connections. This cut context reconstruction time from 10.4s to 3.2s for 45 documents.

### LLM Model Switch

Switched from `@cf/google/gemma-3-12b-it` to `@cf/openai/gpt-oss-20b` based on benchmark data showing faster inference speeds. Updated the API call format to use `input` instead of `messages` and added response parsing for the nested `output[0].content[0].text` structure. This reduced LLM generation time from 10.2s to 8.6s.

### Error Handling

Enhanced error handling in the LLM call function to log detailed response structure information when parsing fails. This helps diagnose API format mismatches and response parsing issues more quickly.

### Results

Total query time reduced from 21.9s to 13.3s (39% improvement). Context reconstruction improved by 70% and LLM generation improved by 15%. No connection warnings observed after implementing immediate body reading.
