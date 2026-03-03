# Worklog: Rearchitect derive from watch-mode to manual CLI

## Context / Brief

We are rearchitecting `derive` from a daemon that watches Claude Code conversation JSONL files to a CLI tool that runs on demand. The tool also needs an Architecture Blueprint, but we are designing and implementing the CLI change first, then blueprinting the result — so the blueprint documents a settled design rather than one we know is about to change.

### Background

`derive` was built as a daemon (`watcher.ts` + chokidar) that monitors `~/.claude/projects/**/*.jsonl` for changes. When a file changes, it indexes the conversation (repo + branch mapping in SQLite) and triggers a spec update. The full development history lives in two worklogs:

- `2026-03-03-machinen-setup.md` — original tool development (watching, indexing, reading, spec maintenance, all the CLI bug investigations)
- `2026-03-03-derive-migration.md` — migration from `machinen-experiments_specs` into the `opposite-actions` monorepo as the `derive` package

### Current architecture (what we are changing from)

- **Daemon mode**: chokidar watches `~/.claude/projects/**/*.jsonl`, triggers indexing + spec updates on file change
- **Stateless spec updates**: each `updateSpec` is a fresh `claude -p` call; the spec file on disk is the state
- **SQLite routing index** (`node:sqlite`): maps conversations to repos/branches, tracks `lastLineOffset` cursors
- **Two-pass Gherkin generation**: extract behaviours, then filter with black box test
- **Excerpt chunking**: large conversations split into 300K-char chunks
- **System tag stripping**: `<system-reminder>`, `<ide_opened_file>`, `<ide_selection>` removed from extracted text
- **`execa`** spawns `claude -p` with `input:` pipe and `--system-prompt`
- **`--reset <branch>`** mode for full spec regeneration

### Target architecture (what we are changing to)

A **manual CLI tool**. When invoked:

1. **Detect context from cwd**: determine the current git repo and branch from the working directory.
2. **Find relevant conversations**: scan `~/.claude/projects/` for JSONL files that belong to this repo+branch. This replaces the watcher — instead of discovering conversations reactively via file-change events, we discover them on demand by scanning the Claude projects directory.
3. **Reconcile state**: compare discovered conversations against what the SQLite index already knows. Index any new conversations, update paths if needed.
4. **Read new messages**: for each conversation, read from the stored `lastLineOffset` cursor (same as today).
5. **Update spec**: call `updateSpec` with the new messages (same stateless `claude -p` approach, same chunking, same two-pass filter).
6. **Exit**: the process runs once and exits. No daemon, no watcher.

### What changes

- **`watcher.ts`** — deleted entirely. chokidar dependency removed.
- **`index.ts`** — rewritten from daemon entry point to single-run CLI. The core `runSpecUpdate` logic stays, but the watcher wiring is replaced by a scan-and-reconcile step.
- **`db.ts`** — may need a helper to look up or insert conversations by repo+branch discovered from scanning.
- **`reader.ts`** — unchanged (still reads JSONL from offsets, strips system tags).
- **`spec.ts`** — unchanged (still does stateless `claude -p` calls with chunking and filtering).
- **`types.ts`** — unchanged or minor adjustments.

### What stays the same

- Stateless spec updates (no `--resume`, spec file is the state)
- SQLite routing index with `lastLineOffset` cursors
- Two-pass Gherkin generation (extract + filter)
- Excerpt chunking for large conversations
- System tag stripping
- `execa` with `input:` pipe and `--system-prompt`
- `--reset` mode (still useful for full regeneration, but branch inferred from cwd instead of passed as arg)

### Open questions for the RFC

- **Conversation discovery**: how do we find JSONL files for the current repo+branch without a watcher? The slugified cwd path gives us the directory (`~/.claude/projects/<slugified_cwd>/`), but we need to open each JSONL and check the `gitBranch` field. Alternatively, we can scan all files in the directory and filter by branch. This is a one-time cost per invocation, acceptable for a CLI tool.
- **Multiple cwds for same repo**: if we work from different directories within the same repo, conversations may live under different slugified paths. We may need to scan more broadly or accept that only conversations from the exact cwd are discovered. For now, matching on the exact cwd slug is simplest and matches how Claude Code stores them.
- **CLI interface**: bare `derive` (no args) for the common case? Or `derive spec` / `derive update`? Keep it simple — bare invocation with `--reset` as the only flag.

### Sequencing

1. RFC the CLI-driven rearchitect (this worklog)
2. Implement it
3. Write the Architecture Blueprint for the resulting system

- NOTE: read all three of the current worklogs to understand the full architecture as it has evolved to its current state

### Status

~Awaiting RFC drafting and alignment.~ RFC drafted below.

---

## RFC: Rearchitect derive from daemon to manual CLI with opt-in watch (v3)

### 2000ft View Narrative

#### The problem: uncontrolled token spend

Spec updates cost tokens — every `claude -p` call is a paid API invocation (via the Claude subscription). The current daemon model fires these calls reactively on every JSONL file change, across every branch, with no user control over which branches warrant the spend. This is a poor first experience: installing derive and running the daemon silently drains tokens on branches where the user may not want or need spec updates.

The deeper tension: we eventually want derive to feel automatic — specs stay current, tests get generated downstream, and the user merges knowing their branch has coverage they did not have to manually create. But we cannot win users into that experience by spending their tokens without consent. The tool must earn trust through explicit opt-in before it can operate in the background.

#### The solution: manual CLI + opt-in watch mode

We replace the global daemon with three modes that give users explicit control over token spend:

- **`derive`** — one-shot update. Discover conversations, read new messages, update spec, exit. The user chooses when to spend tokens.
- **`derive --reset`** — full regeneration. Delete spec, zero offsets, reprocess everything, exit.
- **`derive watch`** — opt-in watch mode. The user explicitly starts watching for the current branch. On conversation changes, re-run the discover→update flow automatically. Scoped to the branch they opted into — not all branches.

The core flow — detect context, discover conversations, reconcile state, update spec — is the same unit of work across all three modes. The difference is only in the trigger: manual invocation, reset flag, or file-change event. `derive watch` is a thin loop around the same `derive` flow, debounced and scoped to one branch.

The key difference from the current daemon: the old watcher watches `~/.claude/projects/` globally and fires spec updates for any branch it encounters. `derive watch` watches only the slug directory for the current cwd and only updates the current branch. The user opts in per branch by running `derive watch` in the repo.

#### Discovery: DB-first reconciliation

The discovery mechanism uses a **DB-first strategy**: query the SQLite index for conversations already known on this repo+branch, list JSONL files in the slug directory, and investigate only the difference. Files already indexed (for any branch) are skipped via a quick primary-key lookup. Truly new files are read to extract their `gitBranch` field from the first message, and those matching the current branch are indexed. After reconciliation, we have a complete conversation list.

Discovery is a **shared prerequisite** for all three modes. This is a change from the current architecture: the existing `resetBranch` only queries the DB and misses any conversations that haven't been indexed yet (because the watcher was the only discovery path). In the new design, discovery runs first unconditionally, so both `runSpecUpdate` and `resetBranch` operate on a complete, reconciled conversation set. After discovery, the paths diverge:

- **Normal mode**: reads from cursors, batches new messages into one `updateSpec` call.
- **Reset mode**: deletes the spec file, zeros all offsets, then processes each conversation sequentially (one `updateSpec` call per conversation — the sequential strategy from the original "Prompt is too long" lesson).
- **Watch mode**: runs the normal mode flow, then starts watching for changes to re-run it.

#### The spec pipeline is unchanged

The entire spec update pipeline (stateless `claude -p` calls, 300K-char chunking, two-pass Gherkin filtering, system tag stripping) is unchanged. We are replacing the trigger mechanism, not the update logic.

### Database Changes

None. The schema (`conversations` + `branches` tables) is unchanged. No new columns, tables, or indexes.

### Behaviour Spec

```gherkin
Feature: CLI spec update

  Scenario: Update spec for current branch
    Given the user is in a git repository on branch "feature-x"
    And Claude Code conversations exist for this repository and branch
    And some conversations have new messages since the last run
    When the user runs derive
    Then new messages are extracted from the conversations
    And the spec file is updated with the new behaviours
    And the process exits

  Scenario: No new messages
    Given the user is in a git repository on branch "feature-x"
    And all conversations are up to date
    When the user runs derive
    Then no spec update is performed
    And the process exits

  Scenario: New conversations discovered
    Given the user is in a git repository on branch "feature-x"
    And a new Claude Code conversation file exists that is not yet indexed
    When the user runs derive
    Then the new conversation is discovered and indexed
    And its messages are included in the spec update

  Scenario: No conversations found
    Given the user is in a git repository on branch "feature-x"
    And no Claude Code conversations exist for this repository and branch
    When the user runs derive
    Then a message indicates no conversations were found
    And the process exits

  Scenario: Reset spec from scratch
    Given the user is in a git repository on branch "feature-x"
    And conversations exist for this branch
    When the user runs derive --reset
    Then the existing spec file is deleted
    And all conversation offsets are zeroed
    And each conversation is processed sequentially from the start
    And the spec is fully regenerated
    And the process exits

  Scenario: Detached HEAD
    Given the user is in a git repository with a detached HEAD
    When the user runs derive
    Then an error message indicates a named branch is required
    And the process exits with a non-zero code

Feature: Watch mode

  Scenario: Watch triggers update on conversation change
    Given the user has started derive watch on branch "feature-x"
    And the watcher is monitoring the slug directory for this cwd
    When a JSONL file in the slug directory is modified
    Then after a debounce period the discover and update flow runs
    And the spec file is updated with new behaviours

  Scenario: Watch discovers new conversations
    Given the user has started derive watch on branch "feature-x"
    When a new JSONL file appears in the slug directory
    Then the new file is discovered and indexed if it belongs to this branch
    And its messages are included in the next spec update

  Scenario: Watch ignores other branches
    Given the user has started derive watch on branch "feature-x"
    When a JSONL file changes that belongs to branch "other-branch"
    Then no spec update is triggered for "other-branch"

  Scenario: Watch runs initial update on start
    Given the user is in a git repository on branch "feature-x"
    When the user runs derive watch
    Then an initial discover and update cycle runs immediately
    And the watcher begins monitoring for subsequent changes
```

### API Reference (CLI)

| Command          | Description                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `derive`         | Update the spec for the current branch. Discover, read new messages, update spec, exit.                                                       |
| `derive --reset` | Regenerate spec from scratch. Delete existing spec, zero offsets, reprocess all conversations sequentially, exit.                             |
| `derive watch`   | Run an initial update, then watch for conversation changes on the current branch and re-run the update flow automatically. Opt-in per branch. |

All commands infer the repository path from `process.cwd()` and the branch from `git rev-parse --abbrev-ref HEAD`.

### Implementation Breakdown

```
[MODIFY]  src/watcher.ts           — rewrite from global watcher to branch-scoped watcher:
                                      - watches only ~/.claude/projects/<slug>/ (not all projects)
                                      - filters to *.jsonl files
                                      - awaitWriteFinish for partial-write safety
                                      - calls back on add/change events
[MODIFY]  src/index.ts             — rewrite from daemon entry to three-mode CLI:
                                      - main(): detect context → discover → update/reset/watch → exit
                                      - discoverConversations(cwd, branch): DB-first + fs diff
                                      - getCurrentBranch(): shell out to git rev-parse
                                      - getSlugDir(cwd): compute ~/.claude/projects/<slug>/ path
                                      - runSpecUpdate(): unchanged logic, called after discovery
                                      - resetBranch(): --reset infers branch from git (no arg)
                                      - watchMode(): initial update, then start watcher with
                                        debounced re-run of discover→update on changes
                                      - REMOVE: scheduleSpecUpdate (replaced by watch-mode debounce),
                                        pendingSpecUpdates map, onFileChanged, startWatcher import
[NO CHANGE] package.json           — chokidar dependency kept (used by watch mode)
```

No changes to: `db.ts`, `reader.ts`, `spec.ts`, `types.ts`.

### Directory & File Structure

```
derive/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts          # [MODIFIED] three-mode CLI entry point
    ├── watcher.ts        # [MODIFIED] branch-scoped watcher
    ├── types.ts          # unchanged
    ├── db.ts             # unchanged
    ├── reader.ts         # unchanged
    └── spec.ts           # unchanged
```

### Types & Data Structures

No type changes. `ConversationRecord`, `BranchRecord`, `JsonlMessage` remain as-is.

### Invariants & Constraints

- **Explicit token spend**: Tokens are only spent when the user invokes `derive` or `derive --reset` (one-shot), or when the user has explicitly opted in via `derive watch` (ongoing). No silent background consumption.
- **Branch-scoped watch**: `derive watch` only watches and updates the current branch. Conversations for other branches in the same slug directory are ignored.
- **DB-first discovery**: Known conversations come from SQLite first. Only truly unknown JSONL files trigger a read for branch detection.
- **Branch from git**: Determined by `git rev-parse --abbrev-ref HEAD`. Detached HEAD is rejected.
- **cwd is repoPath**: `process.cwd()` serves as the repository path, consistent with the existing convention.
- **Exact cwd slug match**: Only conversations in `~/.claude/projects/<slugified_cwd>/` are discovered. Conversations from subdirectories of the same repo (different cwd → different slug) are not included.
- **Offset semantics unchanged**: `lastLineOffset` cursors and the advance-before-process pattern remain identical.
- **Spec pipeline unchanged**: Stateless `claude -p` calls, `input:` pipe, `--system-prompt`, `extendEnv: false`, `CLAUDECODE` deletion, 300K-char chunking, two-pass filtering — all unchanged.

### System Flow (Snapshot Diff)

**Previous flow (global daemon)**:

```
chokidar detects file change (any branch, any conversation)
  → onFileChanged(jsonlPath)
    → if new: readFromOffset(path, 0) to discover cwd + gitBranch, upsert
    → if known: skip discovery
  → scheduleSpecUpdate (5s debounce)
    → runSpecUpdate(repoPath, branch)
      → getConversationsForBranch → readFromOffset per conv → updateSpec
      → tokens spent (no user consent per invocation)
```

**New flow (CLI + opt-in watch)**:

```
derive                     (one-shot, explicit opt-in)
derive --reset             (one-shot, explicit opt-in)
derive watch               (ongoing, explicit opt-in for this branch)
  ↓
  → detect context: cwd from process.cwd(), branch from git rev-parse
  → discoverConversations(cwd, branch):
      1. getConversationsForBranch(cwd, branch) → known conversations for this branch
      2. list *.jsonl files in ~/.claude/projects/<slug>/
      3. for each file not in known set:
         a. getConversation(id) → if exists (indexed for another branch), skip
         b. if null → readFromOffset(path, 0), check gitBranch field
         c. if branch matches → upsert to DB, add to discovered set
      4. return known + newly discovered
  → if --reset: resetBranch(cwd, branch) → exit
  → else: runSpecUpdate(cwd, branch)
  → if watch: start watcher on slug dir
      → on *.jsonl add/change (debounced):
          discoverConversations(cwd, branch)
          runSpecUpdate(cwd, branch)
  → else: exit
```

The downstream logic (`runSpecUpdate`, `resetBranch`, `updateSpec`, `filterSpec`, `readFromOffset`) is unchanged.

### Suggested Verification

```bash
# One-shot update:
cd /Users/justin/rw/worktrees/opposite-actions_specs
pnpm --filter derive start

# Should: detect branch, discover conversations, update spec, exit

# Reset mode:
pnpm --filter derive start -- --reset

# Should: regenerate spec from scratch, exit

# Watch mode:
pnpm --filter derive start -- watch

# Should: run initial update, then log "watching <slug dir>..."
# Open a Claude Code conversation on this branch, make changes
# Should: debounced spec update triggers automatically

# Typecheck:
pnpm --filter derive typecheck
```

### Tasks

- [ ] Rewrite `src/watcher.ts`: branch-scoped watcher (watch slug dir only, \*.jsonl filter, awaitWriteFinish)
- [ ] Rewrite `src/index.ts`: `main()`, `discoverConversations()`, `getCurrentBranch()`, `getSlugDir()`
- [ ] Add `derive watch` mode: initial update + start watcher with debounced re-run
- [ ] Update `--reset` to infer branch from git (no arg)
- [ ] Remove old daemon code: global watcher wiring, `onFileChanged`, `pendingSpecUpdates` map
- [ ] Verify typecheck passes
- [ ] Run `derive` from repo root and verify one-shot spec update
- [ ] Run `derive --reset` and verify full regeneration
- [ ] Run `derive watch` and verify it triggers on conversation changes
