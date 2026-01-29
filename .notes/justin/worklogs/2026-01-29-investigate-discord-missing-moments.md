# Investigate Discord Missing Moments 2026-01-29

## Initialized the investigation into missing Discord moment streams
We observed in the simulation logs (`/tmp/sim.log`) that while GitHub documents are successfully producing moment streams, Discord documents (e.g., `discord/679514959968993311/.../2025-05-24.jsonl`) are resulting in "(no streams produced)" in the macro synthesis phase.

The logs show that in the `micro_batches` phase, Discord documents are splitting chunks and resolving namespaces, but they don't seem to proceed to planning batches or upserting moments.

Context from macro synthesis output:
- `discord/679514959968993311/1307974274145062912/2025-05-24.jsonl` -> `stream_hash=e3b0c44298...` (empty)
- `discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json` -> `stream_hash=e3b0c44298...` (empty)

In contrast, GitHub issues and PRs are producing streams and moments.

We need to understand:
1. Why `micro_batches` is not producing moments for Discord.
2. If this is a regression or a configuration issue.
