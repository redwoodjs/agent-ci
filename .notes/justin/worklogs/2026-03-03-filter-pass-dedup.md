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
cd /Users/justin/rw/worktrees/machinen_specs
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

---

## Moved detailed instructions from CLI arg to stdin preamble

### Problem

`runClaude` passed the full system prompt (extraction preamble or review prompt) as a `--system-prompt` CLI arg. With `REVIEW_SYSTEM_PROMPT` now longer after the dedup expansion, the arg string was growing toward OS arg length limits. Meanwhile the user prompt was already piped via stdin to avoid exactly this problem — but only the prompt benefited, not the system prompt.

### Solution

Split the `--system-prompt` concern into two parts:

1. **`SYSTEM_PROMPT_OVERRIDE`** — a short, fixed string (`"Output only Gherkin. No commentary, no markdown, no code fences."`) passed as the `--system-prompt` CLI arg. Its only job is to replace the default system prompt and suppress inherited style instructions.

2. **Preamble in stdin** — the detailed role instructions (`SPEC_ROLE_PREAMBLE`, `REVIEW_SYSTEM_PROMPT`) are prepended to the stdin input, separated from the prompt by `---`. Everything goes through stdin; the CLI arg stays short.

### Changes

**`src/spec.ts`**:

1. Added `SYSTEM_PROMPT_OVERRIDE` constant (short, fixed).
2. `runClaude(preamble, prompt)` — renamed `systemPrompt` param to `preamble`. Now constructs `input = preamble + --- + prompt` and passes that via stdin. The `--system-prompt` arg is always the short override.
3. Log line changed from `system:` to `preamble:` to reflect the new semantics.

No changes to callers — `SPEC_ROLE_PREAMBLE` and `REVIEW_SYSTEM_PROMPT` are still passed as the first arg to `runClaude`, they just end up in stdin now instead of on the CLI.

Typecheck clean.

---

## Added streaming progress output

### Problem

After moving to the stdin preamble approach, we noticed the process appeared stuck during the review pass — no output at all while `claude -p` was working. In `-p` (print) mode, Claude buffers everything and returns it in one shot. For long-running passes (the review pass processes the full spec), this means silence for 30–60+ seconds.

### Investigation

1. **Tried `.pipe()` and `on('data', ...)` for stderr** — no effect, because `-p` mode does not emit stderr progress.
2. **Added a heartbeat timer** (printing `waiting... 10s`, `20s`, etc.) — confirmed the process was alive but gave no insight into actual progress.
3. **Discovered `--output-format stream-json`** — requires `--verbose` flag in `-p` mode, otherwise errors with "stream-json requires --verbose".
4. **Tested without `--include-partial-messages`** — only emits complete messages at the end. Not useful for progress.
5. **Tested with `--include-partial-messages`** — emits `content_block_delta` events with token-level text deltas. This is what we need.

### Stream-json event types observed

- `system` — init event, lists available tools and model info
- `stream_event` with subtypes:
  - `content_block_start` — beginning of a content block (text or tool_use)
  - `content_block_delta` — incremental text token
  - `content_block_stop` — end of a content block
  - `message_start`, `message_delta`, `message_stop` — message lifecycle
- `assistant` — full assembled message
- `result` — final result text (what we extract as the output)

### Solution

Switched `runClaude` from buffered `-p` to streaming via `--output-format stream-json --verbose --include-partial-messages`. The NDJSON stream is parsed line-by-line from stdout:

- `content_block_delta` events increment a chunk counter; every 5th chunk prints a `.` to stderr as a progress indicator.
- The `result` event at the end of the stream provides the final output text.
- The heartbeat timer was removed — real streaming progress replaces it.

### Changes

**`src/spec.ts`**:

1. Added `--verbose`, `--output-format stream-json`, `--include-partial-messages` to `execa` args.
2. Changed from `await proc` with buffered result to `proc.stdout?.on("data", ...)` with line-by-line NDJSON parsing.
3. `content_block_delta` events drive progress dots; `result` event captures the final output.
4. Removed heartbeat timer.

Typecheck clean. Confirmed dots appear during both extraction and review passes.

---

## Investigating tool use in spawned agent

### Concern

We can see progress dots now, but the question is: what is the spawned `claude -p` agent actually doing? If it's using tools (reading files, searching the codebase) rather than just generating Gherkin text, that's wasted tokens and time. Both the extraction and review passes receive all their input via stdin — they should not need to access external resources.

### What we know from stream-json

The `system` init event in stream-json lists available tools. If the agent uses tools, they appear as `content_block_start` events with `type: "tool_use"` (instead of `type: "text"`). We can detect these in the existing stream parser.

### Two approaches

1. **Observe first (current plan)**: Extend the stream parser to detect and log tool-use events — `content_block_start` with `type: "tool_use"` would log the tool name. This tells us what the agent is doing without changing its behaviour.

2. **Prevent tool use (future fix)**: `claude -p` accepts `--tools ""` which disables all built-in tools. Since both passes are pure text-in/text-out, this is the clean fix — but we want to observe first to confirm the hypothesis.

### Implementation: structured activity log + verbose mode

We went with option 1 — observe first. Replaced the simple progress-dot logic in `runClaude`'s stream parser with a structured activity log that tracks content block types.

**Normal mode** — structured activity per block type:

- **`thinking`**: prints `[claude] thinking: ` followed by dots as thinking deltas arrive (each delta >80 chars collapses to a single dot).
- **`tool_use`**: prints `[claude] tool_use: ToolName(` on block start, accumulates `input_json_delta` chunks, then prints the tool input (truncated to 200 chars) and `)` on block stop.
- **`text`**: prints `[claude] generating text` on block start, then a `.` every 5th `text_delta` chunk.

This gives a clear picture of the agent's activity sequence: is it thinking, calling tools, or generating text?

**`--verbose` mode** (`derive --verbose` or `derive --reset --verbose`):

Dumps every raw NDJSON line (truncated at 500 chars) with `[claude:raw]` prefix, in addition to the structured output. This lets us inspect the full stream event structure for debugging — event types, content block shapes, delta payloads, etc.

### Changes

**`src/spec.ts`**:

1. Added `VERBOSE` constant — `process.argv.includes("--verbose")`.
2. Stream parser now tracks `currentBlockType`, `currentToolName`, `toolInputBuf` state across `content_block_start` → deltas → `content_block_stop`.
3. In verbose mode, each parsed NDJSON line is logged raw before structured processing.
4. Progress counter renamed from `chunks` to `textChunks` (only counts text deltas now, not all deltas).

No changes to callers or other files. Typecheck clean.

---

## Disabled tools and set low effort for spawned agent

### Rationale

Rather than just observing tool use and reacting, we decided to prevent it upfront. Both the extraction and review passes receive all their input via stdin and produce Gherkin text — they have no reason to read files, search code, or use any tools. Similarly, these are well-specified text transformation tasks, not open-ended reasoning problems — extended thinking adds latency and token cost without benefit.

### Changes

**`src/spec.ts`**:

Added two flags to the `claude -p` args in `runClaude`:

1. `--tools ""` — disables all built-in tools. The agent can only generate text.
2. `--effort low` — minimal thinking budget. Reduces latency and token spend for what is essentially a prompted text transformation.

The structured activity log (thinking/tool_use/text detection) remains in place — it now serves as a safety net. If either flag were somehow ineffective, we'd still see it in the logs.

Typecheck clean.

---

## Deferred review pass for reset mode

### Problem

Analyzing a `--reset --verbose` run revealed the core performance bottleneck: each conversation triggers both an extraction pass and a review pass, all sequential. For 6 conversations that's 12 `claude -p` calls. The intermediate review results are immediately overwritten by the next conversation's extraction — only the final review actually matters.

### Evidence from logs

```
Conv 1: extraction (45 msgs) → review → 2 calls
Conv 2: extraction (53 msgs) → review → 2 calls
Conv 3: extraction (117 msgs) → review → 2 calls
Conv 4: extraction (62 msgs) → review → 2 calls
Conv 5: extraction (137 msgs) → review → 2 calls
Conv 6: extraction (36 msgs) → review → 2 calls
Total: 12 sequential calls
```

Each call also included thinking time despite `--effort low`, compounding the latency. The review pass on intermediate specs is pure waste — those specs exist only as context for the next extraction.

### Solution

Defer the review pass to the end of the reset loop. `resetBranch` now:

1. Calls `updateSpec(messages, sPath, { skipReview: true })` for each conversation — extraction only, writes raw Gherkin to disk.
2. After all conversations are processed, calls `reviewSpecFile(sPath)` once — reads the accumulated spec, reviews it, writes the result.

This reduces 12 calls to 7 (6 extractions + 1 final review).

### Changes

**`src/spec.ts`**:

1. `updateSpec` accepts `opts: { skipReview?: boolean }`. When `skipReview` is true, the review pass is skipped and raw extraction result is written directly.
2. New exported function `reviewSpecFile(sPath)` — reads spec from disk, runs `reviewSpec`, writes result. Standalone entry point for callers that batch extractions.

**`src/index.ts`**:

1. `resetBranch` loop passes `{ skipReview: true }` to `updateSpec`.
2. After the loop, calls `reviewSpecFile(sPath)` once.
3. Import updated to include `reviewSpecFile`.

One-shot mode (`runSpecUpdate`) is unchanged — it still reviews every update since there's typically only one call.

Typecheck clean.

---

## Switched spawned agent model to Sonnet 4.6

Both extraction and review passes are well-specified text transformations — the agent receives all input via stdin and outputs Gherkin. This does not require Opus-level reasoning. Switched to `--model sonnet` for faster generation and lower token cost.

### Changes

**`src/spec.ts`**: Added `"--model", "sonnet"` to `runClaude`'s execa args.

Typecheck clean.

---

## Discovered and cleaned up ghost conversations

### Problem

During a `--reset` run, 61 conversations were being processed for the `specs` branch — far more than the ~6–10 real conversations we knew existed. The spec pipeline was processing its own previous outputs as if they were real development conversations.

### Investigation

Inventoried all 86 JSONL files in `~/.claude/projects/-Users-justin-rw-worktrees-machinen-specs/`. Found that ~62 files had only 4–5 lines each (consistent with short `claude -p` calls) despite file sizes up to 624K. These were session files created by `claude -p` during previous derive runs.

This was a **feedback loop**: each `--reset` run spawns multiple `claude -p` calls (extraction + review per conversation). By default, `claude -p` persists session JSONL files in the same slug directory as the parent. On the next `--reset`, those ghost files are discovered as "conversations" and processed, which creates even more ghost files.

### Evidence

- `grep -l "spec-maintenance agent" *.jsonl` found 60 of 86 files containing derive's system prompt preamble.
- The remaining 26 files (+ 1 current session transcript = 27 total) are real conversations.

### Fix: prevent future accumulation

Added `--no-session-persistence` to the `claude -p` args in `runClaude`. This prevents the spawned process from writing JSONL session files altogether.

### Fix: clean up existing ghost files

1. Removed 60 ghost JSONL files: `grep -l "spec-maintenance agent" *.jsonl | xargs rm`.
2. Deleted all 227 conversation entries for the `specs` branch from `~/.machinen/machinen.db` — these included stale entries pointing to deleted files. A `--reset` will rebuild the index from the 26 remaining real files.

Post-cleanup state: 27 JSONL files remain (26 real conversations + 1 current session transcript). The one remaining file matching "spec-maintenance agent" is this current conversation session which discusses the preamble text — not a ghost.

### Changes

**`src/spec.ts`**: Added `"--no-session-persistence"` to `runClaude`'s execa args.

Typecheck clean.

---

## PR: Add `derive` — spec extraction from Claude Code conversations

### Title

Add `derive`: maintain living Gherkin specs from Claude Code conversations

### Description

## Problem

Engineers build features on branches using Claude Code. Those conversations implicitly contain the evolving behavioural intent of the feature — but that intent is trapped in JSONL logs, not captured in a structured, testable form.

## Solution

We add `derive`, a CLI tool that reads Claude Code conversation logs and maintains a living Gherkin behaviour spec per git branch. It extracts testable product behaviours from conversations and writes them to `.machinen/specs/<branch>.gherkin` in the project directory, where they travel with the branch via git.

The tool provides four modes — all with explicit token-spend control:

- **`derive`** — one-shot update. Discover conversations, read new messages, update the spec, exit.
- **`derive --reset`** — regenerate the spec from scratch. Reprocess all conversations sequentially, with a single review pass at the end. Supports `--keep-spec` to preserve hand-written content as starting context.
- **`derive watch`** — opt-in continuous mode. Run an initial update, then watch for conversation changes on the current branch (debounced, branch-scoped).
- **`derive init`** — create an empty spec file for manual seeding before any conversations are processed.

Under the hood, `derive` maintains a lightweight SQLite routing index (`~/.machinen/machinen.db`) that maps conversations to repos and branches and tracks read cursors. The spec pipeline is stateless: each update is a fresh `claude -p` call (Sonnet, no tools, low effort) that reads the current spec from disk, combines it with new conversation excerpts, and produces an updated spec. A two-pass architecture — extraction then review — ensures specs contain only externally observable behaviours (the "black-box test") and are deduplicated, consolidated, and simplified.

We have dogfooded `derive` on itself: `.machinen/specs/specs.gherkin` is the tool's own behaviour spec, generated from the conversations that built it. When we add test generation from specs, we will use this generated spec to dogfood further — closing the loop from conversations to specs to tests.
