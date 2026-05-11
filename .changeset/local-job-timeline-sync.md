---
"@redwoodjs/agent-ci": patch
"dtu-github-actions": patch
---

refactor(local-job): lift the timeline-sync closure to module scope

`executeLocalJob` had a ~190-line `updateStoreFromTimeline` closure
that read `timeline.json` plus the paused-signal file every 100ms and
updated the RunStateStore. The closure captured six mutable `let`
variables defined just above it; fallow's previous report flagged it
as the biggest remaining complexity hotspot (cognitive 70).

This change pulls the closure to module scope as two helpers:

- `syncTimelineToStore(state, ctx)` — drives one poll tick. Cognitive
  score 22.
- `buildStepsFromTimeline(steps, state)` — folds the raw timeline
  records into the `StepState[]` shape the renderer expects. Cognitive
  score 45.

Both take an explicit `TimelineSyncState` object that the polling loop
mutates between ticks, plus a read-only `TimelineSyncContext` with the
paths, store reference, and `onNewPause` callback.

Also drops `padW` / `totalSteps` from the old closure — they were
computed but never used (legacy padding logic).

No behaviour change; the full local smoke suite passes 45/45.
