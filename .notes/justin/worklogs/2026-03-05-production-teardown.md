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
