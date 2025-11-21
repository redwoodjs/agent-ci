import { SqliteDurableObject } from "rwsdk/db";
import { indexingStateMigrations } from "./migrations";

// context(justinvdm, 21 Nov 2025): This Durable Object manages indexing state.
//
// RELEVANCE:
// It is currently used as an ETag cache to optimize the indexing pipeline. By tracking the `etag` of indexed files,
// we can skip re-processing files that haven't changed in R2, saving significant compute and API costs.
//
// DEPRECATED FUNCTIONALITY:
// Previously, this DO also tracked the list of Vector IDs (`chunk_ids`) for each file to handle deletion before re-indexing.
// We discovered this was unsafe in a "split-brain" environment (Local Worker + Remote Vectorize) because the local DO
// would be empty, leading to index pollution. We have switched to a stateless "Query-Then-Delete" strategy in
// `indexing-worker.ts` for deletion.
//
// The `chunk_ids` column remains in the schema to avoid migration churn but is no longer the source of truth for deletion.
export class EngineIndexingStateDO extends SqliteDurableObject {
  migrations = indexingStateMigrations;
}
