# 2025-11-25: RAG Engine Token Management

## Context
We encountered a `5021` error from the AI gateway: "The estimated number of input and maximum output tokens (139704) exceeded this model context window limit (80000)."

This happened because we were retrieving too many search results and reconstructing full document contexts for all of them, then passing them all to the LLM prompt without checking if they fit.

## Attempt 1: Distributed Token Counting (Failed)
We initially tried to add token counting logic to each source plugin (`GitHubPlugin`, `DiscordPlugin`) and the `DefaultPlugin`.
- **Idea**: Each plugin would check a budget before returning its prompt section.
- **Problem**: `GitHubPlugin` only sees GitHub contexts. It doesn't know if `DiscordPlugin` also has content. If both used their "full" budget, we'd still overflow. Also, `runFirstMatchHook` means only one plugin typically composes the prompt, so the default plugin (which sees everything) was the only real place to do it, but it received pre-formatted strings from other plugins in the original design, making it hard to cut cleanly.
- **Outcome**: Reverted this approach. It was messy and architecturally unsound.

## Attempt 1.5: Default Plugin as Gatekeeper (Intermediate Idea)
We briefly considered having the `DefaultPlugin` handle all token counting during `composeLlmPrompt` by having other plugins return raw data. However, this still conflated "formatting" with "budgeting" and felt like a hack.

## Attempt 2: Centralized Context Optimization (Current Plan)
We pivoted based on the insight that we needed a "token reducer" step—a dedicated phase in the pipeline specifically for fitting content into the budget, separate from generating the content itself.

We realized this step belongs *after* context reconstruction (so we have the full text to count) but *before* prompt composition (so we don't build a prompt that's too big).

### The Plan
1.  **New Hook**: Introduce `optimizeContext(contexts, query, context)` to the `Plugin` interface.
2.  **Placement**: Call this hook in the engine after `reconstructContexts`.
3.  **Logic**:
    *   The hook receives the full list of `ReconstructedContext` objects.
    *   These contexts are already implicitly ranked by relevance (because they come from ranked vector search results).
    *   The `DefaultPlugin` will implement this hook to enforce a global token budget.
    *   It will iterate through the contexts, estimating tokens, and selecting them until the budget (e.g., 80k - reserve) is full.
4.  **Fairness**: By processing the list in its ranked order, we prioritize relevance. If we need source diversity later (e.g., "ensure at least one Discord result"), we can implement that logic in this single hook without changing the plugins.

## Implementation Details
- **Token Estimation**: Using a simple `char length / 4` heuristic.
- **Budgeting**:
    *   Max Tokens: ~80,000 (for Gemma/Llama 3.1 large context)
    *   Output Reserve: 10,000
    *   Prompt Overhead: 1,000
    *   Effective Context Budget: ~69,000 tokens
- **Files to Change**:
    *   `src/app/engine/types.ts`: Add `optimizeContext` to `Plugin`.
    *   `src/app/engine/engine.ts`: Add the hook call.
    *   `src/app/engine/plugins/default.ts`: Implement the token limiting logic.

## Outcome
The centralized `optimizeContext` hook worked perfectly. We successfully implemented it in the `DefaultPlugin`, where it now enforces the global token budget by selecting the most relevant contexts until the limit is reached. This solves the context window overflow issue without complicating individual source plugins.

---

## PR Title
feat: cursor mcp integration & rag token optimization

## PR Description

This PR introduces the Cursor MCP integration POC and fixes the context window overflow issues in the RAG engine.

### Cursor MCP Integration
We've added a local Model Context Protocol (MCP) server that allows Cursor Chat to query Machinen directly.
- **Local Server**: A standalone Node script that proxies requests to the Machinen Worker.
- **Automated Setup**: New `scripts/setup-cursor.sh` bundles the server and configures `.cursor/mcp.json`.
- **Pull-Based Context**: The LLM can now decide when to query the knowledge base for context on architecture or project history.

### RAG Token Optimization
To prevent `5021` context window errors on large queries, we've implemented a centralized token budgeting system.
- **New `optimizeContext` Hook**: A dedicated pipeline step after context reconstruction but before prompt composition.
- **Token Budgeting**: The `DefaultPlugin` now enforces a global token limit (~80k) by selecting relevant contexts until the budget is full.
- **Cleanup**: Simplified source plugins by removing ad-hoc token counting attempts and fixed missing types in the Cursor plugin.
