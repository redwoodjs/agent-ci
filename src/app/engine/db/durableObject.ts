import { SqliteDurableObject } from "rwsdk/db";
import { indexingStateMigrations } from "./migrations";

// context(justinvdm, 21 Nov 2025): This Durable Object is now largely deprecated but kept to avoid complex migration cleanup.
// It was originally used to track indexed file state and, critically, the list of Vector IDs (`chunk_ids`) associated
// with each file to enable deletion before re-indexing.
//
// We discovered this was unsafe in a "split-brain" environment (Local Worker + Remote Vectorize) because the local
// DO would be empty, causing the worker to skip deletion and pollute the remote index with duplicate vectors.
//
// We have switched to a stateless "Query-Then-Delete" strategy in `indexing-worker.ts` that queries Vectorize directly.
// This DO is now only potentially useful as an optimization cache for `etags` to skip re-processing unchanged files,
// but it is no longer the source of truth for index integrity. We keep it around to avoid the hassle of a `deleted_classes` migration.
export class EngineIndexingStateDO extends SqliteDurableObject {
  migrations = indexingStateMigrations;
}
