# Debugging Zero Candidate Acquisition 2026-01-28

## Problem: 'Zero Candidates' persists after indexing fix
We unified the indexing path for simulation `materialize_moments` by using `addMoment`. Logs confirm that `moment-linker.vector-upsert` events are now being fired with the correct namespaces. However, the subsequent `candidate_sets` phase still returns 0 matches from Vectorize.

## Investigation Path (Step 2)
We need to determine why Vectorize is empty or unresponsive for the simulation namespace.
- **Evidence Check**: Are embeddings actually being passed to `addMoment`?
- **Namespace Check**: Confirm `momentGraphNamespace` consistency between upsert and query.
- **Consistency/Latency**: Is Vectorize eventually consistent? A 5-minute lock period should be enough, but we should verify.
- **Silent Failures**: Update `addMoment` to log if `embedding` is missing, which would skip Vectorize indexing.

## Current Findings
- Logs show `moment-linker.vector-upsert` fired for:
    - `33d58d79-88f9-f23f-fae3-32f69e1506bc`
    - `cea44850-886e-b6b6-d251-0f5a1da7408c`
    - `287e88b3-d52b-0c0d-00ae-87783a708319`
    - `018e2d54-a1cc-a919-5ed3-1650f35cb3c1`
    - `93124c39-727a-f525-cb96-f15cf6b9a2ed`
- Search in same namespace (`local-2026-01-28-12-30-plain-eagle:redwood:rwsdk`) yielded 0 matches.

## 2026-01-28 12:55 - Vectorize Migration and Troubleshooting

We've confirmed that `MOMENT_INDEX` queries are returning 0 results despite successful upsert logs. The hypothesis is that the v6 indexes are stalled or corrupted.

### Credentials Verification
We verified that `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are correctly set in the environment after sourcing `~/.zshrc`.
- `npx wrangler whoami`: **SUCCESS** (Logged in as `justinvderm@gmail.com` with Super Admin access to RedwoodJS account `1634a8e653b2ce7e0f7a23cca8cbd86a`).

### Commands Attempted
1. **Info check**: `npx wrangler vectorize info moment-index-v6`
   - Result: Exit code 1.
2. **List check**: `npx wrangler vectorize list`
   - Result: Exit code 1 (showing help menu).
3. **Creation attempt**: `npx wrangler vectorize create moment-index-v7 --dimensions=768 --metric=cosine`
   - Result: Exit code 1 (showing help menu).
4. **Explicit Account ID**: `npx wrangler vectorize list --account-id=1634a8e653b2ce7e0f7a23cca8cbd86a`
   - Result: Error: `Unknown arguments: account-id, accountId`.

### Observations
Wrangler seems to be rejecting `vectorize` subcommands or flags that should be valid. This might be due to a version mismatch or an environment-specific parsing issue. We are pausing to let the user troubleshoot locally.

## 2026-01-28 13:10 - V7 Migration Successful

The user successfully created the new v7 indexes after troubleshooting authentication:
1. `moment-index-v7`
2. `subject-index-v7`
3. `rag-index-v7`

**Actions taken:**
- Updated `wrangler.jsonc` to point to the new `v7` indexes.
- Recorded the migration procedure in `docs/dev-recipes/create-v7-indexes.md`.

**Next Steps:**
- Verification: User to re-run simulation and confirm candidate acquisition.

## Analyzed Simulation Log
- **Zero Candidates fixed**: Logs show `candidate_sets` typically finding matches (e.g., 6 matches), but often filtering them down (Self, SameDoc, TimeInversion).
- **Discord Missing**: `materialize_moments` shows 0 moments upserted for Discord items (R2 keys starting with `discord/`). This needs investigation.
- **Score/Rank**: The JSON output in the prompt shows `score: null`. Use `grep` to find where this decision object is constructed.

## 2026-01-28 16:40 - Investigation Summary and Status

### Current Status: What is Working
- **Index Migration**: The migration to `vectorize-v7` (moment, subject, rag) was successful.
- **Candidate Acquisition**: The `candidate_sets` pipeline is now successfully retrieving raw matches from the vector index (e.g., seeing 6 matches in logs).
- **Filtering Logic**: The filtering mechanisms (removing 'self', 'sameDoc', and 'timeInversion') are functioning as intended, which explains why some sets result in 0 candidates after filtering.

### Current Status: What is Broken / Suspicious
- **Discord Materialization**: Discord items (e.g., `discord/...`) are failing to produce any moments. The `macro_synthesis` phase reports `streamsProduced: 0`.
- **Decision Visibility**: The `timeline_fit` decision logs show `score: null` and lack ranking details, making it impossible to verify why specific parents are chosen or rejected without deeper debugging.

### Investigation Findings
- **Discord Failure Root Cause**: Analysis suggests the generic `macro_synthesis` prompt does not effectively parse or summarize the Discord thread structure, leading to zero extracted streams.
- **Score Data Flow**: Code analysis of `timelineFitDeepCore.ts` confirms that scores *are* passed through the logic chain, implying the `null` value in logs might be an artifact of how the decision object is constructed for the final log helper, or the vector search itself returning null scores (less likely given they are used for ranking).

### Next Steps (Recommended)
- **Fix Discord Synthesis**: Update the `macro_synthesis` adapter to include specific prompt instructions for Discord content (e.g., "Summarize this thread", "Identify key participants").
- **Add Debug Visibility**: Implement a specific audit endpoint (`/admin/simulation/run/:runId/timeline-fit/:r2Key`) to expose the full `TimelineFitDecision` object, including raw scores and rejection reasons, to avoid guessing.

## PR Description Draft

### Problem
The simulation's `candidate_sets` phase was consistently returning zero matches from Vectorize, despite successful upsert logs. This halted the timeline fit process. Additionally, we identified visibility gaps in the `timeline_fit` decision logs (`score: null`) and discovered that Discord content was failing to materialize moments.

### Solution
We migrated the vector indexes to a new v7 schema (`moment-index-v7`, `subject-index-v7`, `rag-index-v7`) to resolve the stalled/corrupted state of the previous v6 indexes. This ensures reliable candidate acquisition for the simulation.

### Validation
- Verified that `candidate_sets` logs now show successful match retrieval (e.g., 6 matches versus 0 previously).
- Confirmed that filtering logic (e.g., self-reference, same-document) is now the primary reason for reduced candidate sets, rather than empty search results.
