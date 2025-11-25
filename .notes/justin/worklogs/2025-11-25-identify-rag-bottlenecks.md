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
