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
