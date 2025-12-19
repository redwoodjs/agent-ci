## Problem
In the latest indexing run, the Discord thread for client-side navigation did not attach under issue 552. It was indexed into the correct namespace, but smart-linker returned zero vector candidates and left the thread as a root.

## Context
- Namespace prefix in this run: `prod-2025-12-19-20-04`.
- Expected attachment: Discord thread `discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json` under GitHub issue 552.
- Smart-linker should query `SUBJECT_INDEX`, then fall back to `MOMENT_INDEX` if empty.

## Findings (from out.log)
### 2025-12-19
- The thread routed to `redwood:rwsdk` and indexed under `prod-2025-12-19-20-04:redwood:rwsdk`.
- Macro stream synthesis ran and produced a stream with a high-importance first macro moment.
- Smart-linker ran for macro moment 0.
- Smart-linker fell back to `MOMENT_INDEX`.
- Candidates were still empty (`matches: []`).
- Smart-linker logged `no attachment` and the thread was written as a subject with `parentId: null`.

### 2025-12-19 (rerun)
- In a subsequent resync run (same prefix), smart-linker returned non-empty candidates for the thread.
- Self-match for the thread scored ~0.97 and appears in the candidate list, but the chosen attachment was GitHub PR 933 with score ~0.80.
- The thread reused the existing moment id and ended up with `parentId` set to PR 933.
- In the same run, issue 552 reused its existing parent as PR 933.
