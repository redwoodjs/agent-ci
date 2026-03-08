# --keep-spec preserves content as LLM context, not files on disk

## Problem

The `--keep-spec` flag was misunderstood as preserving `.feature` files through a reset. Claude-generated tests asserted that hand-written `.feature` files would survive `--reset --keep-spec`, but they were deleted.

## Finding

`--keep-spec` only skips the explicit deletion in `resetBranch`. However, `writeSpec()` (called by `updateSpec`) always does a clean-slate write: it removes all `.feature` files before writing new ones (lines 343-347 in `spec.ts`). The actual semantics of `--keep-spec` are: preserve existing spec content as **starting context** for the LLM. The content flows through `readSpec()` into the prompt, influencing what the LLM produces, but the files themselves are always replaced.

## Solution

Specs and tests should describe `--keep-spec` as "uses existing spec content as context when reprocessing" rather than "preserves existing .feature files on disk."

## Context

Discovered during manual testing of Claude-generated e2e tests for derive. 35/36 tests passed; the one failure was a test asserting file preservation for `--keep-spec`. The spec in `reset-mode.feature` was also inaccurate and was corrected alongside the test.
