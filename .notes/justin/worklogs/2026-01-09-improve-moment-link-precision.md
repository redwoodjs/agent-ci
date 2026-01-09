# Improve moment linking precision (reduce false-positive attachments)

I'm seeing repeated false-positive attachments where two moments get linked because their summaries are semantically similar, even though they are different work items. This tends to happen when common subsystem vocabulary overlaps (routing/auth/indexing/etc), and vector similarity is used too directly as a proxy for "same timeline".

Plan:
- Read the current correlation + timeline-fit code path to see where candidate generation, ranking, and the attachment decision happen, and what is already persisted as audit.
- Add an explicit "work continuity evidence" gate that prefers concrete anchors (canonical tokens, IDs, file paths, error strings) and treats generic semantic similarity as candidate generation only.
- Update architecture documentation to describe the decision model and how attachment is gated/ranked.
- Produce a task list for the refactor and wait for approval before implementing code changes.

## Read-through notes

The current attachment flow:
- Indexing selects an "anchor macro" per stream by importance. It concatenates a small set of high-importance macro titles+summaries and uses that concatenation as the smart-linker query text. This is already aligned with "do not search off the first macro moment only".
- `smart-linker` queries `SUBJECT_INDEX` (fallback `MOMENT_INDEX`) for candidates, filters by namespace, drops placeholder parse-failure moments, and uses a score threshold.
- For up to 3 candidates above threshold, `smart-linker` builds a bounded chain context (root, recent tail, and high-importance sample) and runs an LLM "timeline fit" check.

Where false positives seem likely today:
- The timeline-fit prompt is framed as "Return YES unless clearly wrong" and explicitly says "Prefer YES when there are shared anchor tokens". This biases toward attaching in cases where the candidate is in the same broad area but not the same work item.
- Anchor tokens are extracted for the proposed moment and the candidate parent moment and included as hints, but they are not used as deterministic evidence gating or candidate reranking.

