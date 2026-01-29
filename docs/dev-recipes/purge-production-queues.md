# Purging Production Queues

If simulation runs or indexing jobs are "clogged" or processing stale data, you can purge the production queues to clear the backlog. This is a "clean slate" operation for the asynchronous pipeline.

## Warning
Purging is **destructive** and cannot be undone. All pending messages currently in the queue for the consumer will be permanently deleted.

## Instructions

Use `wrangler` to purge the queues. Note that in non-interactive environments, you must append `--force`.

### 1. Indexing & Simulation Queues
These queues handle the main document processing flow and simulation work units.

```bash
# Purge the main indexing queue (orchestration and doc prep)
npx wrangler queues consumer purge engine-indexing-queue-prod --force

# Purge the chunk processing queue (Evidence Locker vector insertion)
npx wrangler queues consumer purge chunk-processing-queue-prod --force
```

### 2. Ingestion & Event Queues
If the backlog is caused by too many R2 event notifications or ingestion tasks.

```bash
# Purge the R2 event notification queue
npx wrangler queues consumer purge r2-file-update-queue-prod --force

# Purge GitHub ingestion queues (if applicable)
npx wrangler queues consumer purge github-scheduler-queue-prod --force
npx wrangler queues consumer purge github-processor-queue-prod --force
```

## When to use this recipe
- A simulation run is "stuck" because the queue is filled with thousands of stale jobs from a previous configuration.
- You have manually fixed a bug in the processing logic but don't want to wait for the existing "bad" jobs to fail through their retry cycles.
- You have rotated a namespace or prefix and want to ensure no old data leaks into the new environment.
