# Avoid Noisy Subjects 2026-02-08

- [x] Investigate classification logic for subjects and moments <!-- id: 0 -->
- [x] Analyze simulation run results for noise <!-- id: 1 -->
- [x] Propose changes to classification prompting <!-- id: 2 -->
- [ ] Implement and verify improvements <!-- id: 3 -->

## Analyzed subject noise in simulation runs
We reviewed the list of subjects from the latest simulation run. We identified a pattern where minor UI changes ("Removed underline from Button") and administrative tasks ("Scheduled a call") are incorrectly classified as initiatives or subjects.

**Keep Categories:**
* Technical problems/investigations (e.g., Node version issues, SDK mismatches)
* Significant feature proposals or milestones (e.g., pre-fetch strategy, smoke test script)
* Fixes and patches for identified problems.

**Ditch Categories (Noise):**
* Minor aesthetic UI tweaks (e.g., button outlines, removing underlines).
* Small content additions (e.g., "Who We Are" section).
* Coordination/Administrative tasks (e.g., scheduling calls, organizing meetings).

## Decided to pivot to a "Significance Bar" approach
Based on our alignment, we are moving away from specific "wack a mole" exclusions (like UI tweaks). Instead, we will define a generic **Significance Bar** for subjects.

A subject must have **Narrative Weight**:
*   **Problems** must involve investigation or technical hurdles.
*   **Initiatives** must involve structural or functional evolution.

Everything else (cosmetic, administrative, maintenance) is a `chore` or `attempt` and does not count as a subject.

## Consolidated Significance Bar Examples
We discussed real-world examples to align on the threshold:
*   **Rejected**: "Removed underline from Button" (Cosmetic), "Scheduled a call" (Admin), "Added 'Who We Are' section" (Trivial Content).
*   **Accepted**: "Identified SDK mismatch" (Investigation), "Proposed smoke test script" (Structural Evolution).

### Work Task Blueprint
**Context**:
Current classification is too liberal with the "initiative" tag, leading to low-signal subjects. We need a fundamental definition of "Subject" that filters out noise structurally.

**Proposed Changes**:
*   **Modify `src/app/pipelines/macro_classification/engine/core/orchestrator.ts`**:
    *   Require `subjectReason` to justify the organizational significance.
*   **Modify `src/app/pipelines/macro_classification/web/ui/MacroClassificationsCard.tsx`**:
    *   Surface `subjectReason` in the simulation UI.
*   **Modify Knowledge Graph UI (component TBD)**:
    *   Surface `subjectReason` in the subject detail view.
*   **Modify `src/app/engine/synthesis/synthesizeMicroMoments.ts`**:
    *   Update `synthesizeMicroMomentsIntoStreams` to filter out non-narrative activity (maintenance/cosmetic) early.
    *   Add rule: "If the activity does not contribute to a narrative of problem-solving or strategic development, prefer to omit it."

**Verification Plan (Manual)**:
* We will suggest the user run a simulation iteration with the new prompts and check if the noisy subjects are gone.
* Specifically, look for whether "Removed underline from Button" still appears as a subject.

## Approved the Implementation Plan
We are moving forward with the implementation of the Significance Bar for subject classification and surfacing 'subjectReason' in the UI. We have confirmed the database schema supports the necessary fields.

## Completed the Implementation
We have updated the classification and synthesis logic to include the Significance Bar and Narrative Weight criteria. We have also updated the database helpers and UI components to surface the 'subjectReason' justifications. The architecture blueprints have been revised to reflect these changes.

## Drafted Pull Request

### Title
Refine Subject Classification with Significance Bar and Narrative Weight

### Description
#### Problem
The Knowledge Graph was being cluttered with low-signal "subjects" such as cosmetic CSS tweaks, administrative label changes, and bot status updates. These moments, while chronologically real, lack the technical significance or "narrative weight" required to be useful as organizational entry points in the graph. Furthermore, when subjects were created, the reasoning behind their classification was hidden from the UI, making it difficult to audit the engine's judgment.

#### Solution
We introduced a structured **Significance Bar** based on the concept of **Narrative Weight**.

1. **Prompt Engineering**: Both the `synthesizeMicroMoments` and `classifyMacroMoments` prompts were updated to enforce stricter inclusion/exclusion criteria. The classifier now explicitly separates organizational subjects (Problems, Initiatives, Opportunities) from incidental decisions or chores (Cosmetic fixes, Admin trivia).
2. **Explicit Justification**: The `subjectReason` field is now mandatory for all subject classifications, forcing the LLM to provide a narrative justification for why a moment reaches the significance threshold.
3. **UI/Data Surface Area**: The database ingestion and simulation UI components were updated to fetch and display this `subjectReason`. Users can now see a "Subject Justification" box in the Simulation UI, providing transparency into the engine's reasoning.
4. **Blueprints**: The `runtime-architecture.md` and `subject-moments-and-evidence.md` blueprints were synchronized to reflect these new rules as the source of truth.
