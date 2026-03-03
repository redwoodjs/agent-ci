# Worklog: Expand filter pass to deduplicate and simplify specs

## Context / Brief

We reviewed the generated spec file (`.machinen/specs/specs.gherkin`) and found multiple categories of redundancy that the current filter pass does not catch. The filter pass (pass 2 of the spec pipeline) only removes scenarios that fail the black-box test — it does not deduplicate, merge overlapping scenarios, or simplify redundant ones.

This is a prompt-level change to `FILTER_SYSTEM_PROMPT` in `derive/src/spec.ts`. No code logic changes.

### The evidence: duplicates in the current spec

We identified these categories of redundancy in the live spec:

1. **Same behaviour, different names.** "Update spec for current branch" (one-shot feature) and "Spec is updated when new conversation data arrives" (incremental feature) describe the same observable outcome: new messages exist → run derive → spec is updated.

2. **Same guarantee, different wording.** "Previously captured behaviours are preserved" and "Existing spec is used as starting context" both say: existing spec + new data → merged result. Two framings of one invariant.

3. **Detail already encoded in a parent scenario.** "Spec file uses .gherkin extension" restates what "Spec file is stored in the project directory" already specifies via its path (`feature-x.gherkin`).

4. **Same invariant across modes.** "Conversations for other branches are ignored during spec update" (one-shot) and "Watch ignores conversations for other branches" (watch) describe the same branch-filtering rule, just triggered differently.

5. **Similar "no data" outcomes.** "No conversations found for the branch" (one-shot) and "Reset with no conversations reports no data" (reset) — same observable result, different trigger.

### Why the current filter misses these

The `FILTER_SYSTEM_PROMPT` applies only the black-box test. All of the above scenarios _pass_ the black-box test — they describe externally observable behaviour. The filter's instruction is explicitly: "Do not rewrite kept scenarios, output them exactly as they are." It has no mandate to compare scenarios against each other.

### Root cause

Duplication arises from **incremental accumulation**. Each `updateSpec` call sees the existing spec plus new conversation excerpts. The extraction pass (pass 1) may restate a behaviour that is already captured — under a different name, in a different feature, or with different wording. Over multiple runs, these redundancies compound. Reset mode processes each conversation sequentially, which further increases the chance of restating the same behaviour from a different conversation's perspective.

---

## RFC: Expand filter pass to review, deduplicate, and simplify specs

### 2000ft View Narrative

#### The problem: specs accumulate redundant scenarios

The spec pipeline's two-pass architecture (extract → filter) was designed to separate "what behaviours exist" from "which are externally observable." The filter pass reliably removes implementation-detail scenarios. But it does not address a second quality problem: **redundancy**. Duplicate, overlapping, and subset scenarios accumulate across incremental updates, producing specs that are longer than necessary and harder to maintain.

This matters because specs are a working artifact — they are the input to downstream tooling (test generation) and human review. Redundancy in the spec translates directly to redundant tests, wasted tokens on future spec updates (the spec-on-disk is fed back as context), and cognitive overhead for anyone reading the spec.

#### The solution: broaden the filter pass mandate

We expand the filter pass from a pure remove-or-keep gate into a **review pass** that performs four operations:

1. **Filter** — remove scenarios that fail the black-box test (current behaviour, preserved).
2. **Deduplicate** — identify scenarios that describe the same observable behaviour and merge them into one. When merging, prefer the more specific or descriptive scenario and discard the other.
3. **Consolidate** — when the same invariant appears across multiple features (e.g., branch-filtering stated in both one-shot and watch), keep it in the most natural location and remove the duplicate. If the invariant applies universally, state it once in the most general feature.
4. **Simplify** — remove scenarios where the assertion is already fully encoded in another scenario (e.g., "uses .gherkin extension" is a subset of "file is stored at ...feature-x.gherkin").

The pass remains a single `claude -p` call. We are changing the system prompt, not adding a third pass.

#### What changes

- **`FILTER_SYSTEM_PROMPT`** in `spec.ts` — expanded instructions covering all four operations.
- The variable name `FILTER_SYSTEM_PROMPT` is renamed to `REVIEW_SYSTEM_PROMPT` to reflect the broader mandate.
- The `filterSpec` function is renamed to `reviewSpec` to match.
- Log lines updated to say `[review]` instead of `[filter]`.

#### What stays the same

- Two-pass pipeline architecture (extract → review).
- `runClaude` function, `updateSpec` flow, chunking logic.
- The black-box test remains the primary quality gate within the review pass.
- The review pass is still stateless — one `claude -p` call per invocation.

### Database Changes

None.

### Behaviour Spec

No change to externally observable behaviour. The filter/review pass is internal to the spec pipeline — the user sees only the resulting spec file. The quality of the spec improves (fewer duplicates), but the interface (CLI commands, file locations, exit codes) is unchanged.

### API Reference

No changes. CLI interface is unchanged.

### Implementation Breakdown

```
[MODIFY]  src/spec.ts    — replace FILTER_SYSTEM_PROMPT with REVIEW_SYSTEM_PROMPT
                            rename filterSpec() to reviewSpec()
                            update log prefix from [filter] to [review]
                            update call site in updateSpec()
```

No changes to: `index.ts`, `watcher.ts`, `db.ts`, `reader.ts`, `types.ts`.

### Directory & File Structure

No new files. Single file modified:

```
derive/
└── src/
    └── spec.ts           # [MODIFIED] review pass prompt + function rename
```

### Types & Data Structures

No type changes.

### Invariants & Constraints

- **Black-box test remains primary.** The review pass still removes implementation-detail scenarios. The dedup/consolidate/simplify operations are applied _after_ the black-box filter, to the surviving set.
- **No semantic invention.** The review pass must not invent new scenarios or add behaviours not present in the input. It can only keep, merge, or remove.
- **Merge preference.** When two scenarios describe the same behaviour, the review should keep the more specific/descriptive one. When merging is required (combining two partial descriptions), the result must be traceable to the originals.
- **Feature structure preserved.** The review pass should not restructure Feature groupings unless doing so is necessary to eliminate a cross-feature duplicate. It should prefer removing the duplicate over reorganising.

### System Flow (Snapshot Diff)

**Previous (filter-only):**

```
extraction pass → raw Gherkin
  → filterSpec(raw)
    → FILTER_SYSTEM_PROMPT: remove implementation-detail scenarios
    → output: filtered Gherkin (may contain duplicates)
  → write to disk
```

**New (review pass):**

```
extraction pass → raw Gherkin
  → reviewSpec(raw)
    → REVIEW_SYSTEM_PROMPT: remove implementation details,
      then deduplicate, consolidate cross-feature overlaps,
      simplify subset scenarios
    → output: reviewed Gherkin (deduplicated and simplified)
  → write to disk
```

### Suggested Verification

```bash
# Reset spec to regenerate from scratch with the new review pass:
cd /Users/justin/rw/worktrees/opposite-actions_specs
pnpm --filter derive start -- --reset

# Compare the regenerated spec against the current one.
# Expect: fewer scenarios, no duplicates, same coverage of observable behaviours.
```

### Tasks

- [x] Replace `FILTER_SYSTEM_PROMPT` with `REVIEW_SYSTEM_PROMPT` in `spec.ts`
- [x] Rename `filterSpec()` to `reviewSpec()` and update call site
- [x] Update log prefix from `[filter]` to `[review]`
- [x] Verify typecheck passes

---

## Implemented review pass

All changes in `derive/src/spec.ts`:

1. **`FILTER_SYSTEM_PROMPT` → `REVIEW_SYSTEM_PROMPT`**: Expanded from a single remove-or-keep gate to a four-operation review (filter, deduplicate, consolidate, simplify). The black-box test is preserved as operation 1. Operations 2–4 address scenario redundancy.

2. **`filterSpec()` → `reviewSpec()`**: Function renamed. The user-facing prompt changed from "Remove any scenarios that fail the black box test" to "Filter, deduplicate, consolidate, and simplify" — matching the four operations in the system prompt.

3. **`filtered` → `reviewed`**: Variable and error message at the call site updated to match the new naming.

4. **Log prefix**: `[filter]` → `[review]`.

Typecheck clean.

---

## Implemented `--reset --keep-spec`

Added a `--keep-spec` modifier flag for `--reset`. When present, the existing spec file is preserved as starting context for the reprocessing — conversation offsets are still zeroed and all conversations are reprocessed sequentially, but the spec file is not deleted first.

This is useful when the user has hand-edited the spec (or seeded it via `derive init`) and wants to reprocess all conversations without losing their manual additions.

### Changes

**`src/index.ts`**:

1. `resetBranch` signature: added `opts: { keepSpec?: boolean }` parameter (defaults to `{}`).
2. The `fs.unlinkSync` call is now gated on `!opts.keepSpec`.
3. `main()` arg parsing: passes `{ keepSpec: args.includes("--keep-spec") }` to `resetBranch`.

Typecheck clean.
