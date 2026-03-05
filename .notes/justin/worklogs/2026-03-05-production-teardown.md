# 2026-03-05 — Production Teardown: Delete All Cloudflare Resources

## Context

We are shutting down the Machinen project entirely. This means deleting all Cloudflare resources across all environments (production, test, rag-experiment-1, dev-justin). The R2 bucket `machinen` is explicitly **kept**.

## Investigation

Reviewed `wrangler.jsonc` to build a complete inventory of all resources. The project has:
- 3 worker deployments (default/prod, rag-experiment-1, dev-justin; test shares the default worker)
- 11 Durable Object bindings across 7+ classes (with SQLite state)
- 8 production queues + 4 DLQs = 12 prod queues, plus equivalent sets for test, experiment, and dev
- 3 production Vectorize indexes + 2 experiment + 2 dev = 7+ total
- 1 cron trigger (every minute heartbeat)
- R2 bucket `machinen` — **KEEP, do not delete**

## RFC: Teardown Plan

### 2000ft View

We delete all Cloudflare resources for the Machinen project in a safe order. The worker must be deleted last because Durable Objects are namespaced under it. Queues and Vectorize indexes are account-level resources and can be deleted independently.

### Teardown Order & Rationale

The order matters:
1. **Delete workers first** — this stops the cron, stops processing, and makes DOs inaccessible. Wrangler handles DO cleanup when the worker is deleted.
2. **Delete queues** — account-level, independent of workers.
3. **Delete Vectorize indexes** — account-level, independent of workers.

Note: Durable Objects cannot be individually deleted via `wrangler`. They are cleaned up when the worker that owns them is deleted. The SQLite data within DOs is destroyed with them.

### Step-by-Step Plan

We will execute these one at a time, confirming each before proceeding.

#### Phase 1: Delete Workers (stops crons, DOs, and all processing)

- [ ] **1.1** Delete production worker: `wrangler delete --name machinen`
- [ ] **1.2** Delete dev-justin worker: `wrangler delete --name machinen-dev-justin`
- [ ] **1.3** Confirm rag-experiment-1 worker name and delete it

Note: The `test` environment likely shares the default worker name. The `rag-experiment-1` env doesn't define a custom `name`, so it may deploy as `machinen` with env suffix — we need to check.

#### Phase 2: Delete Queues (all environments)

**Production queues:**
- [ ] **2.1** `github-scheduler-queue-prod`
- [ ] **2.2** `github-processor-queue-prod`
- [ ] **2.3** `github-processor-queue-prod-dlq`
- [ ] **2.4** `engine-indexing-queue-prod`
- [ ] **2.5** `engine-indexing-queue-prod-dlq`
- [ ] **2.6** `r2-file-update-queue-prod`
- [ ] **2.7** `discord-scheduler-queue-prod`
- [ ] **2.8** `discord-processor-queue-prod`
- [ ] **2.9** `discord-processor-queue-prod-dlq`
- [ ] **2.10** `discord-gateway-events-queue-prod`
- [ ] **2.11** `discord-gateway-events-queue-prod-dlq`
- [ ] **2.12** `chunk-processing-queue-prod`

**Test queues:**
- [ ] **2.13** `github-scheduler-queue`
- [ ] **2.14** `github-processor-queue`
- [ ] **2.15** `github-processor-queue-dlq`
- [ ] **2.16** `engine-indexing-queue`
- [ ] **2.17** `discord-scheduler-queue`
- [ ] **2.18** `discord-processor-queue`
- [ ] **2.19** `discord-processor-queue-dlq`
- [ ] **2.20** `discord-gateway-events-queue`
- [ ] **2.21** `discord-gateway-events-queue-dlq`

**Experiment queues (rag-experiment-1):**
- [ ] **2.22** `github-scheduler-queue-rag-experiment-1`
- [ ] **2.23** `github-processor-queue-rag-experiment-1`
- [ ] **2.24** `github-processor-queue-rag-experiment-1-dlq`
- [ ] **2.25** `engine-indexing-queue-rag-experiment-1`
- [ ] **2.26** `engine-indexing-queue-rag-experiment-1-dlq`
- [ ] **2.27** `r2-file-update-queue-rag-experiment-1`
- [ ] **2.28** `discord-scheduler-queue-rag-experiment-1`
- [ ] **2.29** `discord-processor-queue-rag-experiment-1`
- [ ] **2.30** `discord-processor-queue-rag-experiment-1-dlq`
- [ ] **2.31** `discord-gateway-events-queue-rag-experiment-1`
- [ ] **2.32** `discord-gateway-events-queue-rag-experiment-1-dlq`

**Dev queues (dev-justin):**
- [ ] **2.33** `github-scheduler-queue-dev-justin`
- [ ] **2.34** `github-processor-queue-dev-justin`
- [ ] **2.35** `github-processor-queue-dev-justin-dlq`
- [ ] **2.36** `engine-indexing-queue-dev-justin`
- [ ] **2.37** `engine-indexing-queue-dev-justin-dlq`
- [ ] **2.38** `r2-file-update-queue-dev-justin`
- [ ] **2.39** `discord-scheduler-queue-dev-justin`
- [ ] **2.40** `discord-processor-queue-dev-justin`
- [ ] **2.41** `discord-processor-queue-dev-justin-dlq`
- [ ] **2.42** `chunk-processing-queue-dev-justin`

#### Phase 3: Delete Vectorize Indexes

- [ ] **3.1** `rag-index-v8` (production)
- [ ] **3.2** `moment-index-v8` (production)
- [ ] **3.3** `subject-index-v8` (production)
- [ ] **3.4** `rag-index-v2` (experiment)
- [ ] **3.5** `moment-index-rag-experiment-1` (experiment)
- [ ] **3.6** `rag-index-dev-justin` (dev)
- [ ] **3.7** `moment-index-dev-justin-v2` (dev)

#### Phase 4: Verification

- [ ] **4.1** `wrangler whoami` — confirm account
- [ ] **4.2** List remaining queues: `wrangler queues list`
- [ ] **4.3** List remaining vectorize indexes: `wrangler vectorize list`
- [ ] **4.4** Confirm R2 bucket `machinen` still exists

### Invariants
- R2 bucket `machinen` must NOT be deleted
- All operations target account `1634a8e653b2ce7e0f7a23cca8cbd86a`

### Commands Reference

```bash
# Workers
wrangler delete --name machinen
wrangler delete --name machinen-dev-justin

# Queues (repeat for each queue name)
wrangler queues delete <queue-name>

# Vectorize
wrangler vectorize delete <index-name>
```

### Notes
- Wrangler may prompt for confirmation on each delete — that's expected
- If a queue has a consumer attached, we may need to remove the consumer first (but since we're deleting the worker first, consumers should already be detached)
- Some queues from the config may not actually exist if that environment was never deployed — `wrangler queues delete` will just error, which is fine

## Revised Approach — DO Deletion via Migration Deploy

Dashboard per-DO deletion was too slow and unreliable. Revised plan:

1. Modify `wrangler.jsonc`: remove all DO bindings, add v15 migration with `deleted_classes` for all active DO classes
2. Deploy — single deploy runs the delete migration for all DOs at once
3. `wrangler delete` the worker
4. Delete queues and vectorize indexes via CLI

### DO classes to delete (all active, not previously deleted)

Standard classes:
- RealtimeDurableObject
- DiscordWebhookBatcherDO

SQLite classes:
- Database
- CursorEventsDurableObject
- GitHubRepoDurableObject
- GitHubBackfillStateDO
- EngineIndexingStateDO
- DiscordBackfillStateDO
- SubjectDO
- MomentGraphDO
- EngineSimulationStateDO
- SpeccingStateDO

Already deleted (v10): DiscordGatewayDO — skip.

## Deploy Attempt 1 — R2 Binding Error

Attempted `wrangler deploy`. Got:

```
R2 binding error for bucket 'machinen': Please enable R2 through the Cloudflare Dashboard. [code: 10136]
```

Account has been downgraded to free tier. R2 is not available on free. Need to remove the R2 binding from `wrangler.jsonc` to get past Cloudflare's deploy-time validation. We are keeping the bucket itself (it still exists on the account), just unbinding it from the worker so the deploy can proceed.

## Deploy Attempt 2 — Stub Worker + Stripped Config

Replaced `src/worker.tsx` with a minimal stub (returns 503 "shutting down"). Stripped all bindings from `wrangler.jsonc`: R2, vectorize, AI, queues (producers + consumers), crons, env blocks. Only the migration history and v15 `deleted_classes` remain.

Got: `Queue handler is missing` error (code 11001). CF validates that the deployed code exports a `queue` handler if the *existing* deployment has active queue consumers. Even though our config now has `consumers: []`, the prior deploy still had them registered — CF does a smoke test against the new code before accepting the deploy.

## Deploy Attempt 3 — Add No-Op Handlers

Added no-op `queue()` and `scheduled()` handlers to the stub worker to satisfy CF's validation. The stub now exports `fetch`, `queue`, and `scheduled` — all no-ops.

## Deploy Attempt 3 — Success

After `pnpm build && wrangler deploy`, the deploy succeeded. The v15 migration ran, deleting all 12 DO classes and their data from the production worker (`machinen`).

## Worker Delete Attempt — Queue Consumer Dependency

Attempted `wrangler delete --name machinen`. Got:

```
Cannot delete this Worker as it is a consumer for a Queue. Remove it from the Queue's consumers first, then retry. [code: 10064]
```

CF enforces a dependency graph: queues reference the worker as a consumer, so the worker can't be deleted while queue consumers point to it. This means **queues must be deleted before the worker**, not after.

## Revised Execution Order

The correct teardown order, accounting for CF's dependency enforcement:

1. ~~Delete workers first~~ — **wrong**, workers can't be deleted while queue consumers reference them
2. **Deploy stub with DO deletion migration** — ✅ done for prod
3. **Delete queues** — removes the consumer dependency on the worker
4. **Delete the worker** — now unblocked
5. **Delete vectorize indexes** — account-level, independent
6. Repeat for other environments (dev-justin, rag-experiment-1)

### Revised Step-by-Step Plan

#### Phase 1: Production Teardown

- [x] **1.1** Deploy stub worker with v15 DO deletion migration (done)
- [x] **1.2** Delete all production queues (12 queues: `*-prod` + DLQs)
- [ ] **1.3** Delete production worker: `wrangler delete --name machinen`
- [ ] **1.4** Delete production vectorize indexes (3: `rag-index-v8`, `moment-index-v8`, `subject-index-v8`)

#### Phase 2: dev-justin Teardown

- [ ] **2.1** Deploy stub with DO deletion migration to dev-justin env
- [ ] **2.2** Delete dev-justin queues (10 queues: `*-dev-justin` + DLQs)
- [ ] **2.3** Delete dev-justin worker: `wrangler delete --name machinen-dev-justin`
- [ ] **2.4** Delete dev-justin vectorize indexes (2: `rag-index-dev-justin`, `moment-index-dev-justin-v2`)

#### Phase 3: rag-experiment-1 Teardown

- [ ] **3.1** Deploy stub with DO deletion migration to rag-experiment-1 env
- [ ] **3.2** Delete experiment queues (11 queues: `*-rag-experiment-1` + DLQs)
- [ ] **3.3** Delete experiment worker (need to confirm name)
- [ ] **3.4** Delete experiment vectorize indexes (2: `rag-index-v2`, `moment-index-rag-experiment-1`)

#### Phase 4: Test Environment Queues

- [ ] **4.1** Delete test queues (9 queues: unsuffixed + DLQs) — these may share the prod worker, so they might already be unblocked

#### Phase 5: Verification

- [ ] **5.1** `wrangler queues list` — confirm empty
- [ ] **5.2** `wrangler vectorize list` — confirm empty
- [ ] **5.3** Confirm R2 bucket `machinen` still exists

## Queue Deletion Attempt — Dependency Cascade

Ran `wrangler queues list` to see remaining machinen queues. Attempted to delete all remaining ones. Results:

### Successes
- `r2-file-update-queue-rag-experiment-1` — deleted (had 0 producers, no binding)

### Failures — 4 distinct error types

**1. Worker binding references (code 11005)**
- `github-scheduler-queue` → bound to worker `test-github`
- `github-processor-queue` → bound to worker `test-github`
- `engine-indexing-queue-rag-experiment-1` → bound to worker `rag-experiment-1`
- `github-processor-queue-rag-experiment-1` → bound to worker `rag-experiment-1`
- `github-scheduler-queue-rag-experiment-1` → bound to worker `rag-experiment-1`

**Discovery**: There are separate workers `test-github` and `rag-experiment-1` deployed on the account that we didn't know about. These are not just wrangler env names — they're actual deployed worker scripts with queue bindings.

**2. DLQ consumer references (code 11005)**
- `github-processor-queue-dlq` → referenced as DLQ by consumer `d7519a8d-...`
- `github-processor-queue-rag-experiment-1-dlq` → referenced as DLQ by consumer `e38d54b5-...`

**Discovery**: DLQs can't be deleted while a consumer's `dead_letter_queue` config points to them. The parent queue's consumer must be removed first.

**3. R2 event notification targets (code 11017)**
- `r2-file-update-queue-prod` → target for R2 event notifications on `machinen` bucket
- `r2-file-update-queue-dev-justin` → same

**Discovery**: The R2 bucket has event notification rules pointing to these queues. Must remove the event notification config from the bucket before the queue can be deleted.

### Revised Dependency Graph

The full dependency chain is:

```
R2 event notifications → r2-file-update queues
Workers (test-github, rag-experiment-1) → queues (as producer/consumer bindings)
Queue consumers → DLQs (as dead_letter_queue references)
Queues (as consumer) → machinen worker (blocks worker deletion)
```

### Corrected Teardown Order

Per environment, the order must be:

1. Remove R2 event notifications from the bucket (unblocks r2-file-update queues)
2. Delete the environment-specific workers (`test-github`, `rag-experiment-1`) or at minimum unbind their queues — but those workers may also have DO/queue consumer deps, creating the same chicken-and-egg
3. Delete queues (parent queues first, then DLQs become unblocked)
4. Delete the main `machinen` worker
5. Delete vectorize indexes

## Breaking the Dependency Cycle

Discovered `wrangler queues consumer remove <queue> <worker>` — removes a worker's consumer reference from a queue without deleting either. This breaks the chicken-and-egg cycle.

### Executed

1. Removed all consumer references from all machinen queues (test-github, rag-experiment-1, machinen workers)
2. Deleted workers: `test-github` ✅, `rag-experiment-1` ✅, `machinen` ✅
3. Deleted remaining queues (test, rag-experiment-1, all DLQs) ✅

### Still blocked

Two R2 event notification queues can't be deleted:
- `r2-file-update-queue-prod` — R2 event notification target
- `r2-file-update-queue-dev-justin` — R2 event notification target

The R2 event notification config on the `machinen` bucket references these queues, and the notification can't be removed via CLI because R2 is disabled on the free plan (error 10136). These need to be removed via the Cloudflare dashboard if possible, or we may need to re-enable R2 temporarily.

## Vectorize Index Cleanup

Deleted all 25 machinen-related vectorize indexes, including old rotations (v2–v7) that weren't in the current wrangler config. `wrangler vectorize list` now shows zero indexes on the account.

## Final State

### Deleted ✅
- All 3 workers: `machinen`, `test-github`, `rag-experiment-1`
- All 12 DO classes (via v15 migration deploy)
- All machinen queues except 2 R2 notification targets
- All 25+ vectorize indexes (current + historical rotations)

### Remaining (blocked by free plan) ⚠️
- `r2-file-update-queue-prod` — R2 event notification target, can't remove on free plan
- `r2-file-update-queue-dev-justin` — same
- R2 bucket `machinen` — intentionally kept

### Invariant held
- R2 bucket `machinen` still exists (not deleted)
