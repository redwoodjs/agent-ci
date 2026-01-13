# Timeline fit as a linking plugin

## Problem

Parent selection currently mixes two separate concerns:

- candidate generation (vector search and deterministic filters)
- attachment decision (whether a candidate timeline is a valid parent)

The current flow can reject a candidate before the attachment decision runs (example: a vector score threshold), even when the proposed moment contains explicit anchors that should force evaluation (example: a pull request body says it closes an issue).

This makes attachment behavior sensitive to small score differences and makes it harder to reason about which step rejected a candidate.

## Constraints

- Candidate evaluation must remain bounded per proposed moment.
- Decisions must use only data available at indexing time.
- Attachment must remain time-ordered (parent not later than child).
- Decisions should persist enough audit data to explain why a parent was chosen or rejected.

## Approach

Split linking into explicit plugins that each own one decision:

### Candidate generators

Plugins that propose candidate attachment points. Examples:

- Vector search candidate generator: query the moment index, return topK candidates in the same namespace.
- Anchor match candidate generator: if the proposed moment includes issue/pr references, return those referenced subjects (when they exist in the namespace).

Candidate generators do not decide attachment. They only return candidates and supporting evidence (scores, anchors, timestamps).

### Timeline fit decision

A timeline fit plugin evaluates candidate timelines using bounded chain context and returns one of:

- attach to candidate parent (and optionally provide a reason)
- reject candidate (and provide a reason)

The decision plugin is the single place where "worth considering" is decided. Candidate generators can be conservative, but they should not exclude candidates solely on a score threshold when explicit anchors indicate continuity.

### Deterministic rejects (preconditions)

Some rejects are preconditions that apply to all candidates:

- namespace mismatch
- time inversion (parent later than child)
- missing moment row

These checks can remain deterministic and run before the timeline fit decision.

## Functional outcomes

- Explicit anchors (issue/pr refs) can force candidate evaluation even when vector scores are below a fixed threshold.
- Candidate generation and attachment decision are separated, which makes audit logs easier to interpret.
- The timeline fit decision can be swapped or extended by adding plugins, without coupling it to a specific candidate generator.

