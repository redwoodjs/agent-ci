# 2026-01-12-redwoodjs-sdk-pr-issue-reconcile

## Noticed PRs are being treated as issues

Some GitHub documents under github/redwoodjs/sdk appear under the issues path even when they are pull requests. This leaks into the engine GitHub plugin, which infers document type from the R2 key path.

## Plan

- Add a one-off admin endpoint that:
  - queries GitHub for issue numbers and identifies which ones are pull requests
  - scans R2 under github/redwoodjs/sdk/issues/ and github/redwoodjs/sdk/pull-requests/
  - moves misfiled objects (including history) between the two prefixes
  - updates document ids in the moment graph DB and indexing state DB from old key to new key
  - supports dry run vs apply

- Add a small scheduler fix to avoid enqueueing pull requests when backfilling issues.

## Implemented one-off reconcile endpoint and scheduler filter

I added an engine admin endpoint to reconcile redwoodjs/sdk issue vs pull request documents.

It:

- queries GitHub issues list and uses the pull_request field to classify numbers
- scans R2 under github/redwoodjs/sdk/issues/ and github/redwoodjs/sdk/pull-requests/
- for mismatches, moves the full per-number prefix (including history) between issues and pull-requests
- updates document ids in the moment graph DB and indexing state DB for the moved latest.json keys
- supports dryRun (default true) vs apply

I also updated the GitHub backfill scheduler to skip items from the issues endpoint that are actually pull requests.

## Apply run hit Cloudflare API-request cap

I tried running the reconcile endpoint with dryRun=false (apply mode) without limiting scope.

The request failed with Cloudflare error code 1101, and the worker logs show the underlying exception:

- Error: Too many API requests by single worker invocation.

This makes sense because apply mode currently iterates every mismatch and does multiple R2 operations per object (list, get, put, delete), plus DB updates.

Next change: make the endpoint process mismatches in bounded batches (batchSize) so a local script can loop until the mismatch count reaches 0.
