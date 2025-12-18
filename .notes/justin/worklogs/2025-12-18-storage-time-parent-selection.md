## Problem
Query-time anchoring can pick the intended subject (for example GitHub issue 552) even when vector search would otherwise anchor on a high-volume Cursor tree.

However, the issue timeline can still contain only the issue's own moments, which suggests that other related documents were not attached under that issue during indexing.

Separately, current storage-time parent selection does not enforce a temporal ordering constraint. This can allow a later event to become a parent of an earlier event, which breaks the timeline interpretation.

## Context
- The engine indexes documents into a Moment Graph as a chain of macro moments.
- Storage-time linking chooses a parent moment for the first macro moment, then chains subsequent macro moments under it.
- Cross-source linking currently relies on a similarity query plus LLM gating.

## Hypothesis
- Cross-source candidates that would anchor under a GitHub issue are either:
  - not selected (similarity / filtering),
  - rejected by the attachment gate, or
  - attached under a different root (for example a Cursor conversation root).
- Without an explicit parent-precedence rule, GitHub/Discord moments can be placed under Cursor roots.
- Without a parent-before-child constraint, attachment choices can create timelines that contradict timestamp ordering.

## Plan
- Document storage-time parent selection rules:
  - Prefer GitHub issues/PRs and Discord threads/day documents as parents over Cursor conversations.
  - Enforce that the chosen parent must not be later than the child (based on the best available time range).
- After the rules are documented and approved, implement them in the storage-time linker and reindex affected namespaces.

## Progress
- Implemented candidate filtering and ranking in the storage-time linker:
  - Candidate filter: when both timestamps are present, reject candidates where parent end time is after child start time.
  - Candidate ranking: prefer GitHub candidates, then Discord, then Cursor, then other sources.
  - The existing similarity threshold and LLM gate are still applied after ranking.
