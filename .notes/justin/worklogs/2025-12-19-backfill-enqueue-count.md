## Problem
`/admin/backfill` is only enqueuing a few hundred files in a namespace prefix where earlier runs enqueued over a thousand.

I want to confirm whether the lower enqueue count is expected (because most files are already indexed for that namespace prefix) or caused by a scan / filtering / limit bug.

## Plan
- Trace the backfill code path from the route handler through the scanner and indexing state checks.
- Identify any explicit limits (max keys, pagination caps) and any filters (prefix, source allowlist, exclusions).
- Cross-check how "already processed" is determined per namespace prefix.

## Findings
- The backfill route scans R2 and uses indexing state to decide whether a key is already processed.
- The scan code reads indexing state using a null namespace context, so indexing state is treated as global across namespace prefixes.
- When a namespace prefix is provided, this causes the scan to treat most keys as already processed, even though the prefixed namespace has not been indexed yet.

## Progress
- Updated the backfill scan call so when a namespace prefix is provided, it enqueues all indexable keys (it does not consult indexing state during the scan).
