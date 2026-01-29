# Investigate Discord Missing Moments 2026-01-29

## Initialized the investigation into missing Discord moment streams
We observed in the simulation logs (`/tmp/sim.log`) that while GitHub documents are successfully producing moment streams, Discord documents (e.g., `discord/679514959968993311/.../2025-05-24.jsonl`) are resulting in "(no streams produced)" in the macro synthesis phase.

The logs show that in the `micro_batches` phase, Discord documents are splitting chunks and resolving namespaces, but they don't seem to proceed to planning batches or upserting moments.

Context from macro synthesis output:
- `discord/679514959968993311/1307974274145062912/2025-05-24.jsonl` -> `stream_hash=e3b0c44298...` (empty)
- `discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json` -> `stream_hash=e3b0c44298...` (empty)

In contrast, GitHub issues and PRs are producing streams and moments.

We need to understand:
1. Why `micro_batches` is not producing moments for Discord.
2. If this is a regression or a configuration issue.

## Root Cause Identified: Plugin Chunking Logic Bug
We found that the `githubPlugin.splitDocumentIntoChunks` function (and others) was returning an empty array `[]` when the document source did not match its intended type. Because `runFirstMatchHook` in `pluginPipeline.ts` treats any non-null/non-undefined result as a match, the first plugin in the list (`githubPlugin`) was "claiming" all documents, even Discord ones. This resulted in an empty chunk array being returned for all non-GitHub documents, which then caused the `micro_batches` simulation adapter to skip them.

## Analyzed plugin orchestrator logic and confirmed the "false match" bug
We confirmed that the indexing system uses a `runFirstMatchHook` pattern. In `src/app/engine/indexing/pluginPipeline.ts`, the `splitDocumentIntoChunks` function iterates through plugins and stops at the first one that returns a non-null result. 

We discovered that `githubPlugin.splitDocumentIntoChunks` (and others like `cursorPlugin`) returns `[]` when the document source doesn't match. Because `[]` is truthy and not `null`, the orchestrator thinks the plugin "handled" the document but found zero chunks. This prevents the `discordPlugin` from ever being called for chunking.

Evidence:
- `src/app/engine/indexing/pluginPipeline.ts` L58-60: `const chunks = await runFirstMatchHook(plugins, (plugin) => plugin.splitDocumentIntoChunks?.(document, indexingContext));`
- `src/app/engine/plugins/github.ts` L213-215: `if (document.source !== "github") { return []; }`

Decision: We need to change all indexing plugins to return `null` instead of `[]` when they don't handle the source, ensuring the fall-through logic works as intended.

## Drafted the Work Task Blueprint for fixing plugin chunking logic
We have prepared a plan to fix the chunking bottleneck. This plan ensures that plugins only "own" documents they are actually designed to handle, allowing the `discordPlugin` to process Discord data correctly.

### Context
Discord documents were skipping the planning and upserting phases of the simulation because the `githubPlugin` was incorrectly claiming them during the chunking phase and returning an empty list of chunks. This "false positive" match in `runFirstMatchHook` is the primary blocker for Discord moment generation.

### Breakdown of Planned Changes
* [MODIFY] `src/app/engine/plugins/github.ts`: Change `splitDocumentIntoChunks` to return `null` if source is not `github`.
* [MODIFY] `src/app/engine/plugins/discord.ts`: Change `splitDocumentIntoChunks` to return `null` if source is not `discord`.
* [MODIFY] `src/app/engine/plugins/cursor.ts`: Change `splitDocumentIntoChunks` to return `null` if source is not `cursor`.

### Directory & File Structure
```text
src/app/engine/plugins/
├── [MODIFY] github.ts
├── [MODIFY] discord.ts
└── [MODIFY] cursor.ts
```

### Invariants & Constraints
* **Orchestrator Fall-through**: Plugins MUST return `null` if they cannot handle a document, allowing other plugins to attempt processing.
* **Non-destructive**: This change must not affect the chunking logic for documents that *do* match the plugin.

### System Flow (Snapshot Diff)
**Previous Flow**:
`runFirstMatchHook` -> `githubPlugin` returns `[]` -> Orchestrator stops -> Document has 0 chunks -> `micro_batches` skips document.

**New Flow**:
`runFirstMatchHook` -> `githubPlugin` returns `null` -> Orchestrator continues -> `discordPlugin` returns `Chunk[]` -> Orchestrator stops -> Document has N chunks -> `micro_batches` processes document.

### Suggested Verification (Manual)
1. Run a simulation containing both GitHub and Discord documents.
2. Observe `micro_batches` logs: Discord documents should now show "process.planning_batches" and "process.upserting_moments".
3. Verify macro synthesis output shows non-empty moment streams for Discord.

### Tasks
- [x] [MODIFY] `githubPlugin.splitDocumentIntoChunks` to return `null` on non-match.
- [x] [MODIFY] `discordPlugin.splitDocumentIntoChunks` to return `null` on non-match.
- [x] [MODIFY] `cursorPlugin.splitDocumentIntoChunks` to return `null` on non-match.
- [ ] Verify fix in simulation run.

## Received plan approval and noted skepticism regarding the "false match" theory
We discussed the findings, and we decided to proceed with the plan to fix the `splitDocumentIntoChunks` return values. We noted some skepticism about whether this is the *only* issue, but we agreed it must be resolved to rule out the possibility of a bottleneck in the plugin orchestrator. We are now proceeding to Step 6 (Revise Architecture Blueprint) to codify this plugin contract.

## Completed Step 6: Revised Architecture Blueprint
We created `docs/blueprints/plugin-system.md` to explicitly define the `First-Match` hook contract. We codified the invariant that plugins MUST return `null` on non-match to ensure the orchestrator correctly falls through to the intended handler. This addresses the ambiguity that led to the `githubPlugin` blocking Discord data. We are now starting Step 7: Implementation.

## Completed Step 7: Implementation
We updated `src/app/engine/types.ts` to allow `null` for the `splitDocumentIntoChunks` plugin hook. We then modified `github.ts`, `discord.ts`, and `cursor.ts` to return `null` instead of `[]` when the document source does not match the plugin's intended type. We also fixed a minor typing issue in `CursorConversationLatestJson` that was causing unrelated lint errors in `cursor.ts`. We are now ready for verification.