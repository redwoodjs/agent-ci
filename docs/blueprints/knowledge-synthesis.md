# Knowledge Synthesis Blueprint

**Status**: Living Document
**Last Updated**: 2026-01-26

## 1. Purpose

The Knowledge Synthesis subsystem transforms continuous, unstructured strings (Discord chats, Git diffs) into discrete, structured **Moments**.

## 2. The Micro-Macro Pipeline

We use a two-stage synthesis process to handle volume and noise.

### Stage 1: Micro-Moments (Atomic)
*   **Input**: Raw Chunks (lines of text).
*   **Process**: Break stream into atomic "Micro-Moments".
*   **Why**: Caching. If a Discord thread has 50 messages and we add 1, we only re-process the last chunk. The previous 49 messages yield the same Micro-Moments (cached).
*   **Artifact**: `MicroBatch` (List of atomic events).

### Stage 2: Macro-Synthesis (Narrative)
*   **Input**: Stream of Micro-Moments.
*   **Process**: LLM "Historian" summarizes the stream into `MacroMoments`.
*   **Logic**:
    *   **Filtering**: Ignore noise ("LGTM", lunch plans).
    *   **Summarizing**: Combine related micro-events into one Macro-Moment (e.g., "Discussed and agreed on API design").
    *   **Anchoring**: Extract "Anchors" (canonical tokens like `issue:123`, `pr:456`) for checking.
*   **Output**: `MacroMoment` (Title, Summary, Anchors).

## 3. Materialization

Once synthesized, moments are "Materialized" into the database.

*   **Stable Identity**: A moment's ID is derived deterministically from its position in the stream (e.g., `hash(runId + docId + streamIndex)`). This ensures reruns don't duplicate moments.
*   **State**: At this stage, moments exist but are **Unlinked**. They have no parents yet.

## 4. Invariants

*   **Content Identity**: If the input text hasn't changed, the Moment ID must not change.
*   **Identity Purity**: A moment's identity must be derived from its primary content (e.g., Issue Body). Secondary content (Comments) must not alter the core identity or summary, though it may provide context.
*   **Noise Filtering**: The system must be robust to "comment noise". A casual mention of an issue in a comment should not change the *identity* of the main issue moment.
*   **Provenance**: Every moment must track its `source_metadata` (where did it come from?) for debugging.
