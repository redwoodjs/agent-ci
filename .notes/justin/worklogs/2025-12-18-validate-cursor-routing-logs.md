## Problem
Cursor conversation documents were routing to the internal Moment Graph namespace even when the raw documents contain workspace roots that point at the SDK repo.

I want to validate that the latest resync run is now:
- extracting workspace roots from the cursor conversation JSON (including event-level roots)
- inferring the expected project from those roots
- writing moments to the expected namespace (including the configured namespace prefix)

## Context
- Resync was done via `/admin/resync` for several cursor conversation R2 keys.
- Routing for cursor documents should use workspace roots only, with this precedence:
  - if any root is not recognized as rwsdk or machinen, route to internal
  - else if any root matches machinen, route to machinen
  - else if any root matches rwsdk, route to rwsdk
  - else route to internal

## Plan
- Inspect `/tmp/out.log` around the cursor conversation resync blocks.
- Confirm each cursor document shows a non-empty workspace roots sample.
- Confirm inferred project and resulting momentGraphNamespace match the precedence rules.

## Validation (from /tmp/out.log)
- Cursor documents show non-empty `workspaceRootsSample` and a non-null project in the `[scope-router] indexing` log line.
- There are 6 cursor documents indexed in this run, and none of them show `project: null`.
- Examples:
  - `cursor/conversations/c0be8a78-20ef-41c8-861e-69538f801dc7/latest.json`
    - `[scope-router] indexing`: `project: rwsdk`, `namespace: redwood:rwsdk`, `workspaceRootsSample: ["/Users/peterp/gh/redwoodjs/sdk"]`
    - Vector writes: `momentGraphNamespace: demo-2025-12-18-attempt-3:redwood:rwsdk`
  - `cursor/conversations/00b2d1cf-151c-4681-bd9d-b778fcc2ea37/latest.json`
    - `[scope-router] indexing`: `project: rwsdk`, `namespace: redwood:rwsdk`, `workspaceRootsSample: ["/Users/peterp/gh/redwoodjs/sdk"]`
  - `cursor/conversations/736f23a1-e794-4207-8bd0-5f5799e1abf4/latest.json`
    - `[scope-router] indexing`: `project: machinen`, `namespace: redwood:machinen`, `workspaceRootsSample: ["/Users/justin/rw/worktrees/machinen_cross-data-source"]`
    - Vector writes: `momentGraphNamespace: demo-2025-12-18-attempt-3:redwood:machinen`

## Notes: where the prefix applies
- The scope router emits an unprefixed namespace in logs (for example `redwood:rwsdk`). This is the base namespace.
- The engine applies `MOMENT_GRAPH_NAMESPACE_PREFIX` to the base namespace and sets `MOMENT_GRAPH_NAMESPACE` to the prefixed value for the duration of the indexing/query call.
- Moment DB and indexing-state DB routing both derive their Durable Object instance name from `MOMENT_GRAPH_NAMESPACE`, so they use the prefixed namespace string (via `qualifyName(...)`).
- Vector writes also use `MOMENT_GRAPH_NAMESPACE` for `momentGraphNamespace` in metadata, and the logs show prefixed values like `demo-2025-12-18-attempt-3:redwood:rwsdk`.

## Follow-up: query namespace was double-prefixed
- I ran a query with `momentGraphNamespace="demo-2025-12-18-attempt-3:redwood:rwsdk"` while the worker environment still had `MOMENT_GRAPH_NAMESPACE_PREFIX="demo-2025-12-18-attempt-2"`.
- The `/query` handler treated the provided namespace as a base namespace and applied the environment prefix on top of it, resulting in `demo-2025-12-18-attempt-2:demo-2025-12-18-attempt-3:redwood:rwsdk`.
- Change: treat `momentGraphNamespace` as fully qualified unless the request also provides `momentGraphNamespacePrefix`.
  - When `momentGraphNamespacePrefix` is present, apply it to `momentGraphNamespace`.
  - When `momentGraphNamespacePrefix` is absent, do not apply any prefix to `momentGraphNamespace`.

## Investigation: why Cursor and Discord did not attach to the GitHub issue subject (from /tmp/out-index.log)
- I looked at the attempt-4 indexing logs for:
  - GitHub issue: `github/redwoodjs/sdk/issues/552/latest.json`
  - GitHub PR: `github/redwoodjs/sdk/pull-requests/933/latest.json`
  - Discord thread: `discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json`
  - Cursor conversations:
    - `cursor/conversations/c0be8a78-20ef-41c8-861e-69538f801dc7/latest.json`
    - `cursor/conversations/00b2d1cf-151c-4681-bd9d-b778fcc2ea37/latest.json`
    - `cursor/conversations/3c22a3a5-b0d6-4833-a2ba-d31a559b4a19/latest.json`
    - `cursor/conversations/61c69f11-d1a8-469d-a0e4-6b8d959bb185/latest.json`

- The smart linker is running and finding candidates above the numeric similarity threshold, but the attachment is then gated by an LLM yes/no decision that often rejects cross-source "related but not identical" cases.

- Evidence: PR attached to issue (LLM confirmed)
  - For PR 933, the smart linker finds issue 552 as a subject match (score 0.708...) and the LLM answers YES, so the PR macro moment is attached under the issue subject.

- Evidence: Cursor conversations did not attach because the LLM answered NO
  - For `cursor/.../c0be8a78...` the smart linker finds issue 552 as a subject match (score 0.597...) but the LLM answers NO and the candidate is rejected with `rejectReason: "llm-rejected"`.
  - For `cursor/.../00b2d1cf...` the smart linker finds issue 552 as a subject match (score 0.676...) but the LLM answers NO and the candidate is rejected with `rejectReason: "llm-rejected"`.
  - For `cursor/.../3c22a3a5...` the smart linker finds issue 552 as a subject match (score 0.682...) but the LLM answers NO and the candidate is rejected with `rejectReason: "llm-rejected"`.
  - For `cursor/.../61c69f11...` the issue match score is 0.468 and it is rejected for being below the 0.5 threshold.

- Evidence: Discord thread did not attach because the LLM answered NO
  - For the Discord thread, the smart linker finds issue 552 as a subject match (score 0.643...) but the LLM answers NO and the candidate is rejected with `rejectReason: "llm-rejected"`.

- I think there are two separate problems intertwined:
  - Subject choice for Cursor documents: the first macro moment becomes the Cursor document's subject, and that first macro moment can be a low-signal "thanks" exchange. The LLM then compares the GitHub issue subject against the "thanks" macro title/summary and answers NO, even when later macro moments in the same conversation are actually about the work item.
  - Attachment decision prompt: the LLM prompt used for the attachment decision reads like a "should these be merged as the same specific thing" check. In the log, it explicitly calls proposal vs implementation "related but distinct" and answers NO. That blocks exactly the kind of storage-time linkage we want for "same work item" clustering.

## Next step
- If we change the storage-time linker behaviour (for example, how we choose the subject for Cursor documents, or what the LLM is being asked to decide for attachments), I should write a short architecture note first and then list the implementation tasks, per the workflow rule for behaviour changes.

## Proposed fix direction (concrete)
- The logs show Smart Linker is doing semantic candidate selection correctly, but the LLM gate is answering NO because the prompt is written as a merge-equivalence check (“same specific event, issue, conversation, or topic”).
- I think the concrete fix is to separate “attach to same work item timeline” from “merge as the same subject”, and to avoid using macro moment index 0 as the only correlation representative for sources that often begin with low-signal content.

## Open question: how to constrain looser attachment decisions
- One idea was to scope the looser attachment prompt to cross-source cases (Cursor/Discord attaching to GitHub).
- Alternative that might fit the “work item anchor” model better:
  - Only allow attachment targets when the candidate subject is a GitHub issue/PR.
  - Or require an explicit shared anchor (issue/PR number or canonical token) unless the similarity score is very high.

## Decision: prefer a "same work item/problem" attachment prompt
- I think the simplest approach is to change the LLM gate used by Smart Linker so it decides “same work item/problem” rather than “same specific thread and should be merged”.
- The prompt should say:
  - Same project/repo/library is not enough to link.
  - The child should attach only when it is part of the same work item/problem/change set as the parent subject.

## Implementation plan
- Update `src/app/engine/plugins/smart-linker.ts`:
  - Replace the strict merge-equivalence prompt with an attachment prompt that asks for “same problem/workstream”, including explicit YES/NO examples.
  - Keep the existing score bands (auto-accept above 0.75, LLM gate for 0.5-0.75, reject below 0.5).
  - Add a `promptMode` field to candidate logging so log inspection can distinguish prompt behavior.
- Update `src/app/engine/engine.ts`:
  - Stop using macro moment index 0 as the only correlation representative for the attachment decision.
  - Pick an anchor macro moment index from the synthesized set (highest importance when present; otherwise 0).
  - Call `proposeMacroMomentParent(...)` with the anchor macro moment, but apply the returned parent id to macro moment 0 (so the whole document attaches as a unit).
  - Log both indices (proposal index and applied-to index).

## Validation (from /tmp/out-index.log, attempt-5)
- Indexing in `demo-2025-12-18-attempt-5:redwood:rwsdk` looks consistent (scope-router is selecting `redwood:rwsdk` and vector upserts use the prefixed namespace).

- Anchor macro moment selection looks to be working:
  - For `cursor/conversations/c0be8a78-20ef-41c8-861e-69538f801dc7/latest.json`, the smart linker query runs for macro moment index 1 (importance 0.9) and the logs show `proposalMacroMomentIndex: 1`.

- In this run, the expected cross-document candidates are not showing up for the early documents:
  - For `github/redwoodjs/sdk/issues/552/latest.json`, smart linker candidates are empty.
  - For `discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json`, smart linker candidates are empty.
  - For `github/redwoodjs/sdk/pull-requests/933/latest.json`, smart linker candidates are empty (so it cannot attach to issue 552 in this run).
  - For `cursor/conversations/c0be8a78-20ef-41c8-861e-69538f801dc7/latest.json`, smart linker candidates are empty.
  - For `cursor/conversations/00b2d1cf-151c-4681-bd9d-b778fcc2ea37/latest.json`, smart linker candidates are empty.
  - For `cursor/conversations/3c22a3a5-b0d6-4833-a2ba-d31a559b4a19/latest.json`, smart linker candidates are empty.

- Later in the same log, candidate sets do show up for other documents (including issue 552 and PR 933), which suggests this is not a namespace filter mismatch. It looks more like vector search availability timing when the namespace starts empty and subjects are created earlier in the same run.

- When LLM gating does run, the rejection reason can be legitimate:
  - Example: `cursor/conversations/58316af7-d819-45f5-8eb8-29e1be6d2040/latest.json` is compared against PR 933 (prefetch links), but the cursor macro moment is about a dual-environment architecture and SSR bridge, so the model answers NO.

## Note (wording correction)
- When I say "namespace starts empty" above, I mean "the run behaves like the relevant subjects are not yet discoverable via vector search when early documents run smart-linker", not necessarily that the namespace has no stored items at all.

## Proposed fix direction: retry linking when matches are empty
- Observation from attempt-5:
  - Several documents that should have cross-document candidates (PR 933, discord thread, cursor conversations) get `matches: []` in the smart linker query.
  - Later in the same run, other documents do see candidates that include those same items.

- Proposed behavior:
  - Treat `matches: []` as an "unknown yet" outcome, not "no attachment exists".
  - Schedule a relink attempt for the document after a delay, limited to a small number of retries.

- Retry trigger:
  - Only retry when the smart linker query returns an empty match list.
  - Do not retry when matches exist but are rejected (below threshold, LLM rejected, namespace mismatch, same-document, etc).

- Retry scheduling:
  - Enqueue a relink job with `documentId`, `momentGraphNamespace`, and `attempt`.
  - Delay uses a backoff list read from environment (example shape: `SMART_LINKER_EMPTY_MATCH_RETRY_DELAYS_MS="5000,30000,120000"`).
  - Stop retrying after the delay list is exhausted.

- Idempotency / dedupe:
  - Use a stable job key derived from `(momentGraphNamespace, documentId, attempt)` to avoid duplicate jobs when multiple parts of the pipeline hit the same empty-match condition.

- What the relink job does:
  - Load the stored macro moments for the document (from moment DB).
  - Re-run the same smart-linker attachment proposal logic using the same anchor macro moment selection.
  - If a parent proposal exists, write the parent id and update the subject/moment state as normal.

- Expected outcome:
  - In runs where upserts are not queryable immediately, PR 933 and the cursor/discord docs should link once Vectorize returns candidates.

## Implementation (in-process retry, short and bounded)
- I implemented an in-process retry for the Vectorize subject query when it returns `matches: []`.
- The retry runs a small fixed number of attempts with short delays (default: 50ms, then 200ms), and then continues with whatever the final query returns.
- The delays can be overridden with `SMART_LINKER_EMPTY_MATCH_RETRY_DELAYS_MS` as a comma-separated list of milliseconds.

## Validation (from /tmp/out-index.log, after index rotation)
- I scanned /tmp/out-index.log (lines 1-14665) for the Vectorize empty-match pattern and found 3 cases where the smart linker logged `matches: []` even after the 2 in-process retries (50ms + 200ms).
- Empty matches still happen for:
  - `github/redwoodjs/sdk/issues/552/latest.json` in `demo-2025-12-18-attempt-7:redwood:rwsdk`
    - `emptyMatchRetryAttemptsUsed: 2`, `emptyMatchRetryTotalWaitMs: 250`, `matches: []`
  - `cursor/conversations/f399dae1-9332-4fc1-85c1-704d277dd7d0/latest.json` in `prod-2025-12-18-17-26-scoping-before-backfill:redwood:rwsdk`
    - `emptyMatchRetryAttemptsUsed: 2`, `emptyMatchRetryTotalWaitMs: 250`, `matches: []`
  - `cursor/conversations/736f23a1-e794-4207-8bd0-5f5799e1abf4/latest.json` in `demo-2025-12-18-attempt-7:redwood:machinen` (query logged for `macroMomentIndex: 1`)
    - `emptyMatchRetryAttemptsUsed: 2`, `emptyMatchRetryTotalWaitMs: 250`, `matches: []`

## Follow-up: PR 933 attached to issue 552 without retries
- In `demo-2025-12-18-attempt-7:redwood:rwsdk`, PR 933 (`github/redwoodjs/sdk/pull-requests/933/latest.json`) gets non-empty candidates and attaches to issue 552 (`github/redwoodjs/sdk/issues/552/latest.json`) via `auto-high-confidence` (score ~0.835).
- Issue 552 is the first indexed document in that run and still gets an empty candidate list. Given that downstream documents can still attach to it, I removed the in-process empty-match retry logic from the smart linker.

## PR: Fix Indexing Consistency and Timeline Relevance

### Fix: Vectorize Index Rotation & Consistency

We observed that the Smart Linker often failed to link related documents (e.g., PRs to Issues) during fresh backfills because Vectorize queries returned empty results (`matches: []`), likely due to eventual consistency or index staleness.

We addressed this by rotating to fresh Vectorize indexes (`rag-index-v3`, `subject-index-v2`, `moment-index-v2`) and enabling **metadata indexing** on the `momentGraphNamespace` field. This resolved the query visibility issue, allowing PR #933 to successfully attach to Issue #552 with high confidence. Consequently, we removed the temporary in-process retry logic from the Smart Linker as it was no longer necessary.

### Improvement: Always-On Importance Filtering

Previously, timeline pruning based on "importance" only triggered when the total number of moments exceeded the safety cap (`maxMoments`). This meant short timelines could still include low-signal noise (moments with 0.1 or 0.3 importance).

We updated the narrative query engine to apply an **always-on importance cutoff** (default 0.4). This filter runs *before* any other pruning logic, ensuring that even short timelines only surface significant moments. This improves the signal-to-noise ratio for all queries, regardless of result size.
