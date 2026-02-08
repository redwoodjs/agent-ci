
## Restored reliability features
We restored the missing retry logic (3 attempts), exponential backoff, and 300s timeout handling that were lost in the refactor. This ensures that callers like `summarize.ts` can rely on the LLM utility to manage transient failures autonomously.
