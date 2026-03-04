# Feature File Split — Multi-file Spec Storage

## Investigated current spec I/O

Current state: specs are stored as a single `<branch>.gherkin` file at `<repoPath>/.machinen/specs/<branch>.gherkin`.

The I/O touchpoints are concentrated in two files:

**spec.ts** — the pipeline:

- `specFilePath(repoPath, branch)` — returns `path.join(repoPath, ".machinen", "specs", `${branch}.gherkin`)` (line 282-284)
- `updateSpec(messages, sPath, opts)` — reads spec from disk at `sPath` via `fs.readFileSync` (line 251), writes result back via `fs.writeFileSync` (line 276). Between chunked iterations, re-reads from disk (same line 251 in the loop).
- `reviewSpecFile(sPath)` — reads from `sPath`, reviews, writes back (lines 191-201)
- All read/write goes through a single `sPath: string` parameter — the file path

**index.ts** — the orchestrator:

- `runSpecUpdate` calls `specFilePath(cwd, branch)` to get `sPath`, passes it to `updateSpec` and `upsertBranch` (lines 144-154)
- `resetBranch` does the same — computes `sPath`, optionally deletes, passes to `updateSpec` with `skipReview: true` per conversation, then `reviewSpecFile(sPath)` once at the end (lines 176-221)
- `init` mode creates the empty file at `sPath` (lines 233-243)

**db.ts / types.ts**:

- `BranchRecord.specPath` stores the single path string
- `upsertBranch` persists it — purely for record-keeping, the path is deterministic

**Key observation**: The LLM pipeline (`updateSpec`, `reviewSpec`) only ever deals with a single string of Gherkin content. It reads it from one file, produces a new version, writes it to one file. The "one file" boundary is entirely an I/O concern — the pipeline doesn't care.

## Proposed change: virtualized multi-file specs

The idea: organize specs as `<repoPath>/.machinen/specs/<feature-slug>.feature` files (one per `Feature:` block), but the LLM pipeline continues to see a single concatenated string. The split is purely mechanical I/O at the boundary.

### What changes

1. **`specFilePath` → `specDir`**: Returns the directory `<repoPath>/.machinen/specs/` instead of a single file path.

2. **New: `readSpec(specDir)`**: Globs `*.feature` in the directory, reads and concatenates all files, returns a single string. This is the "virtualized read."

3. **New: `writeSpec(specDir, gherkin)`**: Parses the Gherkin output by `Feature:` blocks, slugifies each feature name (lowercase, replace non-alphanumeric with `-`, collapse consecutive dashes, trim), writes each to `<slug>.feature`. Before writing, `rm` all existing `*.feature` files in the directory (clean slate — the content was already in memory).

4. **`updateSpec`**: Changes signature from `sPath: string` to `specDir: string`. Uses `readSpec` to get current content, `writeSpec` to persist result. Between chunk iterations, calls `writeSpec` then `readSpec` for the next iteration.

5. **`reviewSpecFile` → `reviewSpecDir`**: Uses `readSpec`/`writeSpec` instead of direct file I/O.

6. **`BranchRecord.specPath`**: Becomes the directory path (or we drop it — path is deterministic from `(repoPath, branch)` regardless, it's always `<repoPath>/.machinen/specs/`).

7. **Init mode**: Creates the directory instead of an empty file. Or creates a single empty `.feature` file — TBD.

8. **Prompts**: No changes. The LLM never knows about files.

### What stays the same

- The two-pass pipeline (extraction + review)
- The chunking logic (300K char limit)
- The conversation discovery and offset tracking
- The DB schema (conversations table untouched)
- The watch mode mechanics
- The `--reset` flow (sequential per-conversation processing)

### The concat+rm+write cycle

Between spec iterations (chunked processing, sequential reset), we need:

1. `writeSpec(dir, result)` — split and write feature files
2. next iteration reads back via `readSpec(dir)` — concat again

This ensures iterative results are visible on disk between iterations.

## RFC: Feature File Split

### 2000ft View

We change the spec storage from a single `<branch>.gherkin` file to multiple `<feature-slug>.feature` files in the `<repoPath>/.machinen/specs/` directory. Each `Feature:` block in the LLM's Gherkin output becomes its own file, named by slugifying the feature name.

The LLM pipeline is unchanged — it continues to operate on a single concatenated string. The split is purely a read/write boundary concern. On read, we glob and concatenate all `.feature` files. On write, we parse by `Feature:` block, rm existing files, and write new ones.

This shift reflects that specs describe **product features**, not branch-scoped work. The directory is shared — any branch's derive run contributes to the same set of feature files. Content is never lost: the rm-before-write happens after the LLM has already consumed the concatenated input and produced its output.

### Behavior Spec

```gherkin
Feature: Multi-file spec storage

  Scenario: Spec output is split into per-feature files
    Given a derive run produces Gherkin with multiple Feature blocks
    When the spec is written to disk
    Then each Feature block is written to a separate .feature file
    And each file is named by slugifying the Feature name

  Scenario: Feature files are concatenated on read
    Given multiple .feature files exist in .machinen/specs/
    When derive reads the current spec
    Then all .feature files are concatenated into a single string
    And this string is used as context for the LLM

  Scenario: Old feature files are removed before writing
    Given .machinen/specs/ contains feature files from a previous run
    When a new spec is written
    Then all existing .feature files are removed
    And only the new feature files are written

  Scenario: Feature name slugification
    Given a Feature block named "CLI spec update"
    When the spec is written to disk
    Then the file is named "cli-spec-update.feature"

  Scenario: Iterative results are visible on disk
    Given a spec update involves multiple chunks
    When a chunk completes
    Then the intermediate result is written as split feature files
    And the next chunk reads the concatenated result back from disk
```

### Database Changes

- `BranchRecord.specPath` changes from a file path to the directory path `<repoPath>/.machinen/specs/`

### Implementation Breakdown

1. `[MODIFY] spec.ts: specFilePath → specDir` — return directory instead of file path
2. `[NEW] spec.ts: readSpec(specDir)` — glob `*.feature`, sort, concat
3. `[NEW] spec.ts: writeSpec(specDir, gherkin)` — parse by Feature blocks, slugify, rm+write
4. `[MODIFY] spec.ts: updateSpec` — use readSpec/writeSpec instead of direct fs calls
5. `[MODIFY] spec.ts: reviewSpecFile → reviewSpecDir` — use readSpec/writeSpec
6. `[MODIFY] index.ts: runSpecUpdate` — use specDir instead of sPath
7. `[MODIFY] index.ts: resetBranch` — use specDir, rm \*.feature instead of unlinkSync on single file
8. `[MODIFY] index.ts: init mode` — create directory (or empty .feature file)
9. `[MODIFY] types.ts: BranchRecord` — specPath semantics change (now a directory)
10. `[MODIFY] blueprints/derive.md` — update architecture blueprint

### Invariants

- The LLM pipeline never sees file boundaries — it operates on a single concatenated string
- A `Feature:` block in the Gherkin output maps 1:1 to a `.feature` file on disk
- The rm-before-write always happens after the content has been consumed and re-expressed by the LLM
- Feature file sort order on read is deterministic (alphabetical by filename)
- Slugification: lowercase, replace non-alphanumeric runs with `-`, trim leading/trailing `-`

### Tasks

- [x] Implement `readSpec` and `writeSpec` helpers in spec.ts
- [x] Refactor `specFilePath` → `specDir` in spec.ts
- [x] Update `updateSpec` to use readSpec/writeSpec
- [x] Update `reviewSpecFile` → `reviewSpecDir`
- [x] Update `runSpecUpdate` in index.ts
- [x] Update `resetBranch` in index.ts
- [x] Remove init mode from index.ts (no longer needed with multi-file)
- [x] Verify BranchRecord type (specPath field unchanged, semantics shift to directory)
- [x] Update architecture blueprint
- [x] Typecheck passes

## Implemented the feature file split

All changes complete. Summary of what changed:

**spec.ts**:

- `specFilePath(repoPath, branch)` → `specDir(repoPath)` — returns `.machinen/specs/` directory (branch removed from path)
- New `readSpec(dir)` — globs `*.feature`, sorts alphabetically, concatenates
- New `writeSpec(dir, gherkin)` — parses by `Feature:` blocks, slugifies names, rm+write
- New `slugify(name)` — lowercase, non-alphanumeric → `-`, trim
- `updateSpec` uses `readSpec`/`writeSpec` instead of direct `readFileSync`/`writeFileSync`
- `reviewSpecFile` → `reviewSpecDir` — uses `readSpec`/`writeSpec`

**index.ts**:

- `runSpecUpdate` and `resetBranch` use `specDir` instead of `specFilePath`
- Reset mode rm's all `*.feature` files instead of unlinking a single file
- Init mode removed entirely

**types.ts**: Unchanged — `BranchRecord.specPath` still a string, now semantically a directory path.

**Blueprint**: Updated throughout — 2000ft view, system flow, pipelines, behaviour spec, API reference, invariants, directory mapping. Init mode removed. Multi-file spec storage feature added.

## RFC: --scope flag for spec subdirectory

### 2000ft View

We add an optional `--scope <name>` CLI flag that appends a subdirectory to the spec path. Without it, specs go to `<repoPath>/.machinen/specs/*.feature`. With `--scope derive`, they go to `<repoPath>/.machinen/specs/derive/*.feature`. This lets projects organize specs by domain without any config machinery — just a CLI arg.

### What changes

1. `[MODIFY] spec.ts: specDir(repoPath, scope?)` — if `scope` is provided, append it to the path: `path.join(repoPath, ".machinen", "specs", scope)`. Otherwise, unchanged.

2. `[MODIFY] index.ts: main()` — parse `--scope <value>` from args, pass to `specDir`, `runSpecUpdate`, and `resetBranch`.

3. `[MODIFY] index.ts: runSpecUpdate(repoPath, branch, scope?)` — pass `scope` through to `specDir`.

4. `[MODIFY] index.ts: resetBranch(cwd, branch, opts)` — add `scope?` to opts, pass through to `specDir`.

### What stays the same

- `readSpec`, `writeSpec`, `updateSpec`, `reviewSpecDir` — all take a `dir: string`, unchanged.
- The LLM pipeline, DB schema, conversation discovery, watch mode.
- When `--scope` is omitted, behaviour is identical to current.

### Behavior Spec

```gherkin
Feature: Spec scope

  Scenario: Scope directs specs to a subdirectory
    Given the user is in a git repository
    When the user runs derive --scope derive
    Then spec .feature files are written to .machinen/specs/derive/
    And spec .feature files are read from .machinen/specs/derive/

  Scenario: No scope uses the default directory
    Given the user is in a git repository
    When the user runs derive without --scope
    Then spec .feature files are written to .machinen/specs/
```

### Implementation Breakdown

1. `[MODIFY] spec.ts: specDir` — accept optional `scope` param
2. `[MODIFY] index.ts: main` — parse `--scope` from args
3. `[MODIFY] index.ts: runSpecUpdate` — accept and forward `scope`
4. `[MODIFY] index.ts: resetBranch` — accept and forward `scope`
5. `[MODIFY] blueprints/derive.md` — document `--scope` in API reference and invariants

### Tasks

- [x] Update `specDir` to accept optional `scope`
- [x] Parse `--scope` in `main()` and thread through `runSpecUpdate` and `resetBranch`
- [x] Update blueprint and API reference
- [x] Typecheck passes

## Implemented --scope flag

Three-line change to `specDir`, plus threading through `main` → `runSpecUpdate`/`resetBranch`. The scope value is parsed from `--scope <name>` in args and forwarded as an optional param. Blueprint updated with API reference row and invariant.

## PR

**Title:** Organize specs as per-feature .feature files with optional --scope

**Description:**

### Problem

Specs were stored as a single `<branch>.gherkin` file per branch. This coupled specs to branches rather than product features, and made it harder to mentally organize the growing set of behaviours.

### Solution

We split spec storage into multiple `.feature` files — one per `Feature:` block in the Gherkin output, named by slugifying the feature name (e.g., `Feature: CLI spec update` → `cli-spec-update.feature`).

The LLM pipeline is unchanged — it operates on a single concatenated string. We introduce a virtualized I/O boundary: `readSpec` concatenates all `.feature` files on read, `writeSpec` parses the output by `Feature:` blocks and writes per-feature files on write. The rm-before-write is safe because the content was already consumed and re-expressed by the LLM.

We also add `--scope <name>` to direct specs into a subdirectory (e.g., `--scope derive` → `.machinen/specs/derive/*.feature`), and remove `derive init` (no longer needed with multi-file storage).

Changes:

- `spec.ts`: Replace `specFilePath` with `specDir(repoPath, scope?)`, add `readSpec`/`writeSpec`/`slugify`, update `updateSpec` and `reviewSpecDir` to use them
- `index.ts`: Thread `scope` through `runSpecUpdate`/`resetBranch`, parse `--scope` from args, remove init mode
- `derive.md`: Update blueprint throughout — system flow, behaviour spec, API reference, invariants, directory mapping
