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
3. Write the Architecture Blueprint for the resulting system (separate worklog)

### Status

Awaiting RFC drafting and alignment.
