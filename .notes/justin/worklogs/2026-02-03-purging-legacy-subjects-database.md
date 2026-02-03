# Purging Legacy Subjects Database 2026-02-03

## Initialized the worklog and reviewed legacy system components
We started the task of purging the legacy `subjects` database and its associated bindings. We also targeted old simulation tables (`simulation_run_micro_batches`, etc.) that are no longer needed after the migration to unified artifact storage.

## Refactored internal retrievals to use unified storage
We updated `runArtifacts.ts` and `runProgress.ts` to use the unified `simulation_run_artifacts` table for all internal retrieval and progress tracking. This allowed us to detach from the legacy per-type tables.

## Purged legacy code and configuration
We removed the legacy simulation table definitions and migrations from `migrations.ts`. We then proceeded to remove the `subjects` property from all plugins (`github`, `discord`, `cursor`) and deleted the associated Durable Object bindings and `SubjectDO` exports from `wrangler.jsonc` and `worker.tsx`.

## Restored essential indexing logic
We discovered that `src/app/engine/subjects` contained necessary logic for generating micro-moments (the new "subjects"). We restored this directory via git checkout to ensure the indexing process remains functional, while maintaining the removal of the legacy database layer.

## Fixed codebase syntax and lint errors
We addressed several syntax errors in the `github` plugin and fixed multiple "implicit any" lint errors in `engine.ts` that were surfacing due to our changes in the orchestrator port objects.

## Fixed simulation progress UI and race conditions
We identified that the simulation progress was showing zeros because the `changed` column in `simulation_run_documents` was not being updated by the new unified worker. We fixed this and also relaxed the `current_phase` check in the worker to allow `dispatchNext` to successfully trigger the next phase even if the run-level phase transition hasn't completed yet. Additionally, we fixed `runArtifacts.ts` to use exact artifact keys for per-document results.
