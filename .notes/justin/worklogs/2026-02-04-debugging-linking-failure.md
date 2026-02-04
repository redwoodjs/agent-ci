# Debugging Linking Failure 2026-02-04

## Initiated investigation into deterministic linking failure
We are investigating why issue #933 is failing to link to #522 in the `deterministic_linking` phase.

## Discovered root cause of linking failure
- The raw document scanning regex `/#(\d{1,10})/` in `orchestrator.ts` is not global (`g`), so it only finds the first match.
- If the document contains its own issue number (e.g. #933) before the target (#522), it stops at the first match.
- The self-link check happens AFTER choosing a candidate, which results in a null parent if the first candidate is self.
- We need a global scan and an explicit filter for the current document's issue number.

## Drafted Work Task Blueprint

### Context
We are resolving the linking failure for issue #933 -> #522 in the `deterministic_linking` phase. The root cause is twofold:
1. The raw document regex scan was non-global, stopping at the first match.
2. The document's own issue number (#933) appeared before the target (#522) in the raw content, causing it to be picked as the link candidate, which then failed the self-link check.

### Breakdown of Planned Changes
* Modify `deterministic_linking/orchestrator.ts`:
    - Implement global regex scanning for issue references.
    - Parse current document's issue number to explicitly filter it from candidates.
    - Log ignored self-references for auditability.

### Directory & File Structure
src/app/pipelines/deterministic_linking/engine/core/
└── [MODIFY] orchestrator.ts

### Types & Data Structures
No changes to public interfaces. Internal logic refinement only.

### Invariants & Constraints
- **Self-Link Prevention**: A document must never link to itself.
- **Ordered Resolution**: We should try to resolve issue references in the order they appear in the document, skipping the self-reference.

### System Flow (Snapshot Diff)
- **Previous Flow**: Scan raw content -> Pick first match -> If match is self, return null.
- **New Flow**: Scan raw content for ALL matches -> Skip self-matches -> Resolve first remaining match.

### Suggested Verification (Manual)
- Rerun `needle-sim-1` and check `deterministic_linking` logs for "found fallback issueRef" and potential self-link skips.

### Tasks
- [ ] Implement global scan with self-link filtering in `deterministic_linking`
- [ ] Verify fix with needle simulation

## Implemented global scan and self-link filtering
We updated `orchestrator.ts` in `deterministic_linking` to use a global regex scan (`matchAll`) and a self-link filter based on the current document's issue number.
- Added `parseIssueNumberFromDocumentId` helper.
- Updated `computeDeterministicLinkingDecision` to skip self-references while scanning raw content.
