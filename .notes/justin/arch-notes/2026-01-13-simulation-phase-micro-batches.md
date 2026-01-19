# Simulation phase: micro_batches (attempt)

## Goal

Compute and cache micro-moment batch summaries for documents that are marked changed by ingest_diff.

This phase produces the micro-level inputs that macro_synthesis consumes.

## Inputs

- run config: r2Keys
- per-run document state from ingest_diff (etag + changed flag)

## Output artifacts (persisted in simulation state DB)

Per-run mapping of documents to micro batches:

- (run_id, r2_key, batch_index) -> batch_hash, prompt_context_hash, status

Global cache for micro batch outputs:

- (batch_hash, prompt_context_hash) -> micro_items_json

## Cache key

batch_hash is computed from the ordered list of chunk ids and chunk content hashes.

prompt_context_hash is computed from the prompt context string used for the micro batch summarizer.

The cache key is (batch_hash, prompt_context_hash).

## Semantics

- If a batch cache entry exists, the phase reuses it and does not call the model.
- If a batch cache entry is missing, the phase calls the micro summarizer model and writes the cache entry.
- If any document fails processing, the run is paused_on_error with last_error_json populated.

## Acceptance checks

- Running micro_batches after ingest_diff produces per-run batch rows for the selected document.
- Restarting from micro_batches and running again reuses the cached batch outputs (no additional cache writes for the same batch key).

