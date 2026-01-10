# Storage-time parent selection

## Problem
The engine attaches documents into a Moment Graph by selecting a parent moment for each document's root moment.

In practice, namespaces can contain many Cursor conversations and other test content. When storage-time linking attaches cross-source content under Cursor roots, GitHub issues and Discord threads do not become the roots of their expected timelines.

Separately, the parent selection step can choose a parent that is later than the child. This produces timelines where a later event appears as an ancestor of an earlier event.

## Constraints
- Parent selection must use only metadata available at indexing time.
- Parent selection must remain deterministic given the same stored data.
- The system must support multiple sources (GitHub, Discord, Cursor) without requiring content inspection.
- The parent link is a strict time ordering: a child must be chronologically later than its parent.

## Approach
Apply two rules when proposing a parent for a document's root moment.

### Rule 1: Parent precedence by source
When multiple candidate parents are available:
- Prefer GitHub issue and pull request moments.
- Then prefer Discord thread and channel-day moments.
- Then allow Cursor conversation moments.

This is applied only to storage-time attachment choice. It does not change namespace routing.

### Rule 2: Prefer parent not later than child, with scrutiny for time inversion
Prefer candidates whose time range starts at or before the child's time range starts.

Time range selection:
- Use the stored time range metadata when present.
- Otherwise use the moment createdAt timestamp.

If a time range start is missing on either side, treat the time ordering as unknown for that candidate.

If a candidate parent starts after the child starts, reject it.

## Functional outcomes
- GitHub issues and pull requests are more likely to be the roots of their cross-source timelines.
- Discord discussions can attach under the relevant GitHub work item when both are present.
- Cursor conversations attach under GitHub/Discord when they refer to the same work item, instead of becoming the default root.
- Narrative queries format timelines by sorting moments using their timestamps, rather than relying on parent link order.
