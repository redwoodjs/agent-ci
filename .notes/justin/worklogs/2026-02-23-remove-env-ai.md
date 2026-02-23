# 2026-02-23 Remove env.AI Support

## Investigated `env.AI` Usage in `llm.ts`

We received a request to remove support for `env.AI` from `src/app/engine/utils/llm.ts`.

Looking at `src/app/engine/utils/llm.ts`:
- The Cloudflare Workers AI provider is used as a fallback when the requested model alias isn't `google` or `cerebras`.
- It relies on `env.AI` via `workers-ai-provider` and `env.AI` from `cloudflare:workers`.
- The `MODELS` constant currently only contains `cerebras` and `google` models, meaning the fallback `else` block is only hit if a non-existent or unsupported alias is passed, or if types are bypassed.

## Draft Plan (RFC)

### 2000ft View Narrative
The goal is to remove the Cloudflare Workers AI (`env.AI`) support from our LLM utility (`src/app/engine/utils/llm.ts`). Since our configured standard `MODELS` dictionary only specifies `cerebras` and `google` models, the fallback `else` block using `env.AI` is no longer needed. We will remove the `else` block that initializes and uses `workers-ai-provider` and replace it with an explicit error to fail fast on unsupported models.

### Database Changes
None.

### Behavior Spec
- GIVEN a call to `callLLM` with a model alias whose provider is not `google` or `cerebras`, WHEN execution reaches the provider dispatch, THEN the function will immediately throw an `Error("Unsupported model provider...")` rather than attempting to lazily load and call Cloudflare AI.

### API Reference
No API changes. The `callLLM` signature remains the same.

### Implementation Breakdown
#### [MODIFY] `src/app/engine/utils/llm.ts`
- Replace the `else { ... }` block that delegates to `workers-ai-provider` via `env.AI` with a fast-fail `throw new Error(...)`.

### Directory & File Structure
```
src/app/engine/utils/
└── llm.ts
```

### Types & Data Structures
No changes.

### Invariants & Constraints
- Only explicitly configured providers in `MODELS` (currently `cerebras`, `google`) are supported by `callLLM`.

### System Flow (Snapshot Diff)
- **Previous**: If a model configuration lacked a `google` or `cerebras` provider, `callLLM` attempted to dynamically import `workers-ai-provider` and use `env.AI`.
- **New**: If a model configuration specifies an unknown provider, `callLLM` throws an immediate unsupported provider Error.

### Suggested Verification
- Run typescript compilation `pnpm tsc --noEmit`.
- Run tests `pnpm test`. (Or any test checking LLM bindings).

### Tasks
- [x] Remove `env.AI` fallback code and replace with `throw new Error(...)` in `src/app/engine/utils/llm.ts`.

## Implementation - Removed `env.AI` Support from `llm.ts`

We have successfully removed the Cloudflare Workers AI fallback from `src/app/engine/utils/llm.ts`.

- **Removed Fallback**: The `else` block in `callLLM` that used `workers-ai-provider` and `env.AI` was deleted.
- **Added Fast-Fail**: Replaced the deletion with an explicit `throw new Error(...)` for unsupported model providers.
- **Fixed TypeScript Error**: Handled the `Property 'provider' does not exist on type 'never'` error by casting `modelConfig` to `any` within the error message, acknowledging that the code path is unreachable under current static type definitions for `MODELS`.
- **Verified Imports**: Confirmed `env` import is still required for logging toggles (`FULL_PROMPT_PREVIEWS`) and ensured it was restored after a brief accidental removal.

### Verification Evidence
- `pnpm tsc --noEmit` confirmed no errors in `src/app/engine/utils/llm.ts`.
- Codespace search shows other files still use `env.AI` (e.g., for embeddings), but per instructions, we focused on the LLM helper specifically.


## Draft PR

### Title
feat: Remove env.AI support from LLM utility

### Narrative Description
#### Context
We are simplifying our LLM provider configurations and moving away from the Cloudflare Workers AI (`env.AI`) fallback in our core LLM utility.

#### Problem
Currently, `src/app/engine/utils/llm.ts` contains a fallback block that attempts to use `workers-ai-provider` and `env.AI` if a model provider doesn't match our primary providers (`google` or `cerebras`). Since our current model configurations only target these two providers, this fallback is unused and adds unnecessary complexity and potential runtime confusion.

#### Solution
We removed the `env.AI` fallback from the `callLLM` function and replaced it with an explicit error handler that fails fast if an unsupported provider is encountered. We also updated the TypeScript types to handle the exhaustive check fallout.
