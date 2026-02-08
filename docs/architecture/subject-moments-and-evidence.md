# Subject moments and evidence-based linking

## Problem

The Moment Graph currently treats subjects as moments with no parent. This conflates:

- topic demarcation (a problem/challenge/opportunity/initiative starts)
- storage-time attachment (a moment follows from another moment)

In practice, topic demarcation can happen inside an existing chain. A later problem can be a consequence of an earlier decision, and still be a separate topic that should be visible as its own entry point in the UI and in query context construction.

The current attachment classifier returns a yes/no decision, but it does not require evidence to be returned in a structured way. This makes it hard to debug why a link was made, especially when the model relies on inferred semantic similarity rather than explicit cross-references in the source content.

## Constraints

- Attachment decisions remain storage-time decisions (no query-time recomputation).
- Parent links continue to represent one chosen predecessor per moment (a tree). Parent links are strictly time-ordered: a child must be chronologically later than its parent.
- Decisions should be inspectable: a user should be able to see what evidence was used to attach a moment and why a moment was marked as a subject.
- The system continues to operate across multiple sources (GitHub, Discord, Cursor).
- Moment replay backfill should be able to reuse the same attachment logic.

## Approach

### 1. Subject is a classification on a moment

Each macro moment can be marked as a "subject moment" independently of whether it has a parent.

A subject moment is a macro moment whose primary role is topic demarcation. It is one of:

- problem
- challenge
- opportunity
- initiative

#### The Significance Bar (Narrative Weight)
To prevent the Knowledge Graph from being cluttered with trivial activity, we enforce a **Significance Bar** for subject classification. A moment is only marked as a subject if it carries substantial **Narrative Weight**.

**Accepted as Subjects:**
- **Significant Problems**: Technical hurdles requiring investigation, regressions, or blocker issues.
- **Structural Initiatives**: New functional surface area, cross-cutting refactors, or multi-step feature developments.
- **Strategic Opportunities**: Non-trivial improvements that change the direction or capability of the system.

**Rejected as Subjects (Noise):**
- **Cosmetic Tweaks**: Margin adjustments, color changes, typo fixes.
- **Administrative Coordination**: Assigning reviewers, updating labels, generic "done" markers without technical detail.
- **Trivial Content Maintenance**: Updating READMEs or documentation files without structural change.
- **Status Chatter**: "I'm working on this", "Will follow up", "Pairing now".

These rejected items should be classified as `chore`, `attempt`, or `decision` but NOT as `subject`.

Subject moments can still attach under an earlier moment when there is a causal or contextual relationship. This keeps cause/effect structure in the tree while still surfacing topic boundaries.

### 2. Macro moments use explicit inclusion criteria

Macro synthesis should emit a macro moment only when it contains at least one of:

- a problem/challenge/opportunity/initiative (these are candidates for subject marking)
- an attempt at a solution
- a decision
- a solution (source-aware; for example, prefer treating a merged pull request as a solution and treat local experimentation as an attempt)

If a micro-moment batch contains none of the above, synthesis should omit it rather than generating a low-signal macro moment.

### 3. Attachment and subject marking require evidence outputs

For both attachment and subject marking, the model output should include:

- the decision
- a list of evidence items that can be traced back to the moment text (canonical tokens, issue/pr references, quoted phrases, error strings, identifiers)
- a short explanation that ties evidence to the decision
- a confidence indicator that is downgraded when only inferred similarity is present

Explicit cross-references (for example: an issue number already present in the candidate timeline, or a canonical token match) should be treated as stronger evidence than purely semantic similarity.

### 4. Query uses subject moments as timeline roots

Narrative query should:

- match an anchor moment using the moment index
- walk ancestors until it reaches the nearest subject moment
- build a timeline from the descendants of that subject moment

If no subject moment exists on the ancestor path, query falls back to the unparented root moment.

### 5. Audit UI surfaces subject markers and evidence

The audit UI should:

- list subject moments separately from unparented moments
- show per-moment subject classification (kind + evidence)
- show per-moment attachment decision artifacts (decision + evidence)

