# Worklog: Refining Speccing Engine & CLI Refactor

## 2026-02-13: Refactoring CLI to TypeScript (RFC)

### 2000ft View Narrative
The current Bash implementation of the Speccing Engine driver (`mchn-spec.sh`) has reached its complexity limit. Handling streaming HTTP responses, Base64 decoding of headers, and robust exponential backoff retries for transient errors (like LLM quota limits) is brittle in shell script.

We are refactoring this into a TypeScript-based script (`mchn-spec.ts`) to be executed via `tsx`. This will provide:
1.  **Type-Safe Persistence**: More reliable handling of the local specification file lifecycle.
2.  **Native Streaming**: Using the Web Streams API (`fetch`) for true unbuffered output.
3.  **Resilient Retries**: Sophisticated retry logic for 429/500 errors.
4.  **Better Diagnostics**: Clearer logging of turn state and LLM progress.

### Behavior Spec
- **GIVEN** a user prompt and environment variables (API_KEY, MACHINEN_ENGINE_URL).
- **WHEN** the script is executed.
- **THEN** it should:
    1.  Discover a relevant subject (or fallback to global search).
    2.  Initialize a speccing session (optionally fuzzy-matching if needed).
    3.  Enter an autonomous loop that streams refinements.
    4.  Update the local `.md` file incrementally as tokens arrive.
    5.  Automatically retry on quota limits (429) or transient server errors (500).
    6.  Exit gracefully when the server signals completion.

### API Reference (CLI)
- **Usage**: `tsx scripts/mchn-spec.ts "<PROMPT>"`
- **Inputs**:
    - `API_KEY`: Auth token.
    - `MACHINEN_ENGINE_URL`: Backend worker URL.
    - `NAMESPACE_PREFIX`: Optional simulation namespace.
    - `REPOSITORY`: Optional repo override (defaults to local git origin).

### Implementation Breakdown
#### [NEW] [mchn-spec.ts](file:///Users/justin/rw/worktrees/machinen_specs/scripts/mchn-spec.ts)
- Use `fetch` for all API calls.
- Implement a `requestWithRetry` wrapper using exponential backoff.
- Implement `streamToStream` helper to pipe the HTTP response body to both `stdout` and the target file using `TransformStream`.
- Use `git` commands via `node:child_process` for environment detection.

#### [DELETE] [mchn-spec.sh](file:///Users/justin/rw/worktrees/machinen_specs/scripts/mchn-spec.sh)
- Remove the legacy bash script.

### Types & Data Structures
```typescript
interface SpeccingMetadata {
  status: "active" | "completed";
  moment?: {
    id: string;
    title: string;
    summary: string;
    createdAt: string;
  };
  isFirstTurn: boolean;
}
```

### Invariants & Constraints
- The local specification file must NEVER be partially overwritten by a JSON error response; it should only contain the streamed markdown contents.
- The script must respect the `retry-after` header if provided by the server.

### Suggested Verification
1.  Run the **Definitive Execution Example** below from the SDK directory.
2.  Observe live streaming output in the terminal and verify the file `docs/specs/*.md` is updated incrementally.
3.  Check server logs for `[speccing:stream] Chunk X sent (+Yms)` to confirm per-token streaming.
4.  Run with `VERBOSE=true` to see `[debug]` timing diagnostics in the CLI.

### Execution Example (Definitive)

Run the following command from the project root or the SDK directory to trigger the autonomous speccing loop with diagnostics:

```bash
VERBOSE=true \
API_KEY=dev \
MACHINEN_ENGINE_URL=http://localhost:5174/ \
NAMESPACE_PREFIX="local-2026-02-11-11-20-gentle-panda" \
npx tsx /Users/justin/rw/worktrees/machinen_specs/scripts/mchn-spec.ts \
"Identified full‑page reload issue for client‑side filters"
```

> [!NOTE]
> `VERBOSE=true` enables timing diagnostics (`[debug]` logs) to measure chunk arrival latency.

### Tasks
- [x] Implement `mchn-spec.ts` boilerplate and environment detection.
- [x] Implement `requestWithRetry` logic.
- [x] Implement subject discovery and session initialization.
- [x] Implement the autonomous streaming loop with live file updates.
- [x] Add `VERBOSE` logging and anti-buffering headers.
- [x] Fix session continuity (infinite loop) by advancing state atomically.
- [ ] Verify functionality and delete `mchn-spec.sh`.

### Test Snippet: Prefetching Feature Replication

```bash
# Workflow Example: Prefetching for client navigation
# Subject: Identified full‑page reload issue for client‑side filters

VERBOSE=true \
API_KEY=dev \
MACHINEN_ENGINE_URL=http://localhost:5174/ \
NAMESPACE_PREFIX="local-2026-02-11-11-20-gentle-panda" \
npx tsx /Users/justin/rw/worktrees/machinen_specs/scripts/mchn-spec.ts \
"Identified full‑page reload issue for client‑side filters"
```
