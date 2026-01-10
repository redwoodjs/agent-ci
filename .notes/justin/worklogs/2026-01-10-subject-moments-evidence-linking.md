# 2026-01-10 - Subjects as moment classification + evidence-based linking

## Problem

Moment replay backfill replays macro moments in event-time order, but the resulting graph has too few moments and the topics/subjects and attachments are not matching expectations.

The current model treats "subject" as synonymous with "root moment" (parent is null). That conflates two separate questions:

- whether a moment is a topic demarcation point (problem/challenge/opportunity/initiative)
- whether a moment is linked to a preceding moment in a timeline

The current attachment reasoning also does not persist enough model output to debug why an attachment (or non-attachment) happened, especially when the model is relying on inferred semantic similarity rather than explicit references in the source content.

## Plan

- Treat "subject" as an orthogonal classification on a moment (a boolean + category + evidence), not a property of having no parent.
- Keep a single parent link per moment (tree) and require strict time ordering: a child must be chronologically later than its parent.
- Allow subject moments to have a parent like any other moment (subject marking is orthogonal to attachment).
- Rewrite the macro synthesis prompt constraints so macro moments are emitted only for:
  - problem/challenge/opportunity/initiative (and mark these as subjects)
  - attempt / decision / solution (with source-aware wording constraints)
- Add a separate classifier step for subject-ness when needed (if macro synthesis is not making that determination reliably).
- For parent selection, require the model to return:
  - a decision (attach to X vs no-attach)
  - a structured set of evidence items (explicit refs like issue/pr tokens, quoted phrases, canonical tokens), plus a short explanation tying evidence to the decision
  - a confidence / strength indicator that is downgraded when only inferred similarity is present
- Persist these decision artifacts and surface them in the debug endpoint and audit UI so attachment and subject decisions are inspectable.

## Context

The moment replay backfill staging work makes it possible to change attachment rules without re-ingesting source documents. It is a good place to iterate on attachment decisions, subject classification, and audit visibility.

## Notes from code inspection

- The engine currently hardcodes the idea that "subjects" are root moments:
  - index path comment: "Root moments (moments with no parent) are indexed in SUBJECT_INDEX as Subjects."
  - query path: "find match -> walk ancestors to root -> descend"
- `subjectDb` exists but does not appear to be used anywhere except its own module. The live subject mechanism is `SUBJECT_INDEX` + root traversal in the Moment Graph.
- `momentDb.addMoment` currently upserts every moment into `SUBJECT_INDEX` and stores `isSubject: !parentId`. This means the "subject index" contains non-subject moments too, and callers can accidentally treat them as subjects unless they filter.
- `smart-linker` uses `SUBJECT_INDEX` as a candidate generator and then runs a timeline-fit LLM prompt that returns only YES/NO. It records anchor token hints in the audit log, but it does not require the model to return explicit evidence or a rationale.

## Architecture draft

- Added an architecture document describing the intended split between subject marking and attachment, and the requirement that both decisions return structured evidence.
- Updated the knowledge synthesis architecture doc to describe subjects as a classification on a moment rather than "moment with no parent".

- Added a subject moment listing query and updated graph stats to include subject and unparented counts.
- Updated chain context and root sampling to treat the nearest subject ancestor as the timeline root for context building.
- Updated smart-linker:
  - candidate generation uses MOMENT_INDEX
  - time inversions are rejected
  - the timeline-fit call returns structured JSON (decision, evidence, explanation, confidence) and is persisted in the audit log
- Added a macro classification step that tags macro moments with moment kind and subject marker fields, plus evidence and confidence.
- Lowered the default macro moment minimum importance cutoff to 0 so macro pruning relies more on prompt constraints + noise filtering.

### PR title

Subject moments + evidence-based linking (strict time ordering)

### PR description

**Previous state**

- Subjects were treated as root moments (parent is null), so topic demarcation and attachment were conflated.
- Parent links could be time-inverted.
- Smart linking produced an attach/no-attach outcome without structured evidence.
- The audit UI centered on root moments and did not surface subject markers or decision evidence.

**Change**

- Added subject markers to moments (subject flag, subject kind, reason, evidence) and separated subject marking from attachment.
- Enforced strict time ordering for parent links at write time (reject parent candidates that start later than the child).
- Changed subject indexing so the subject index contains only subject moments.
- Updated linking to use the moment index for candidate generation, reject time inversions, and persist a structured JSON decision payload (decision, evidence, explanation, confidence) in the linkage audit log.
- Added a macro classification step to tag macro moments with kind (problem/challenge/opportunity/initiative/attempt/decision/solution) and subject markers, including evidence and confidence.
- Updated narrative query and audit UI to treat the nearest subject ancestor as the timeline root, list subject moments, and show classification and linkage details.

**Outcomes**

- Topic demarcation is independent from parentage, so subject moments can live inside an existing chain.
- Parent links are time-ordered.
- Linking and subject decisions are inspectable via persisted evidence.

**Testing**

- `pnpm build`