# Spec/test lifecycle: let the LLM reason about it

## Decision

When `derive tests` re-runs, Claude reads both the current specs and existing test files. Claude decides what to keep, modify, or remove based on whether tests still match the specs. No infrastructure (hashing, drift detection, separate directories) is needed.

The system prompt tells Claude it may modify or remove existing test files that no longer match specs.

## Context

The `--keep-spec` incident surfaced the question: what happens when specs change and tests drift? Five approaches were evaluated:

- A. Full regen (delete all, regenerate) -- no room for human refinement
- B. Generate once, humans own -- tests drift from specs over time
- C. Hybrid directories (generated/ vs human/) -- unclear authority when they conflict
- D. Diff-based regen -- high implementation cost for uncertain gain
- E. Spec-pinned hashes with drift detection -- infrastructure overhead

## Alternatives Considered

All five approaches above were discussed. We wanted wanted "super dead simple" and proposed letting Claude reason about it, since Claude already reads both specs and existing tests during `derive tests`.

## Consequences

- Convention: hand-written tests in separate files are human-owned; generated tests are Claude's to manage
- The system prompt in `gen-tests.ts` needs an addition: "You may modify or remove existing test files if they no longer match the specs"
- Human reviews the diff before committing -- the reviewer is the final authority
- No new infrastructure needed

## Worklog Reference

`.notes/justin/worklogs/2026-03-05-derive-test-generation.md`, section "Decision: spec/test lifecycle -- let the LLM reason about it"
