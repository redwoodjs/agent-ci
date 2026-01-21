# 2026-01-21-r2-listing-sampling-fix

// context(justinvdm, 2026-01-21): Fixed a regression where sampled simulation runs were triggering a full R2 bucket listing instead of using the provided sample keys.

## Investigated sampling regression in r2_listing
We found that the `r2_listing` phase, introduced to handle large backfills via async paging, was ignoring the `config.r2Keys` populated during sampled runs. This caused every run to default to a full bucket scan, negating the performance benefits of sampling and potentially loading all documents into the simulation.

## Implemented fix to respect upfront r2Keys
We updated the `r2_listing` runner to check if `r2Keys` are already present in the simulation configuration. 
- If keys exist, we now chunk them into batches of 1,000 and insert them directly into `simulation_run_r2_batches`.
- We then advance the run to the next phase immediately.
- This bypasses the incremental R2 listing logic entirely for sampled runs while preserving it for the "Run All" backfill path where `r2Keys` starts empty.

This ensures that sampled runs are truly restricted to their intended identifiers.
