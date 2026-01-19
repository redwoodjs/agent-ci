# Namespace-aware backfill and resync

## Problem

Manual backfill and resync operations are used to populate data for demos and for iteration on production.

The Moment Graph supports namespaces to isolate storage and retrieval. Indexing state is also namespaced.

The current backfill flow lists keys in R2 and compares their etags to indexing state to decide what to enqueue. That comparison is implicitly scoped to the worker's current namespace. When the goal is to populate a specific namespace without redeploying the worker, the scan and the enqueued jobs need to run under an explicit namespace override.

## Constraints

- The system should support running backfill/resync against the same R2 source data while writing into a chosen namespace.
- The default behavior should remain unchanged when no namespace override is provided.
- The backfill mechanism should support incremental scans (enqueue only keys that are missing or have changed etags in the target namespace).
- The queue consumer already supports receiving a namespace value in the message body and scoping the job to it.

## Approach

Add a namespace-aware admin endpoint that performs an R2 scan and enqueues indexing jobs with a namespace value attached.

The endpoint sets the namespace override for the duration of the scan, so indexing state lookups and etag comparisons are performed within the target namespace. Each enqueued message includes the same namespace value so the indexing job runs within that namespace.

This supports “populate demo namespace from production R2 data” without changing worker configuration.

## Functional outcomes

- Admin backfill can target a namespace by specifying a namespace override.
- Incremental scans remain incremental within that target namespace.
- Queue indexing jobs run under the intended namespace even when the worker's default namespace is different.

