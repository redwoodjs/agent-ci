# Architecture Blueprint: derive

## 2000ft View Narrative

`derive` is a CLI tool that maintains living Gherkin behaviour specs by extracting intent from Claude Code conversations. Engineers build features on branches using Claude Code. Those conversations — stored as JSONL files — implicitly contain the evolving behavioural intent of the feature. `derive` reads those conversations, extracts testable product behaviours, and maintains structured Gherkin specification files alongside the code. Specs are organized by product feature — each `Feature:` block in the Gherkin output becomes its own `.feature` file, named by slugifying the feature name. The LLM pipeline operates on a single concatenated string; the file split is purely a read/write boundary concern.

The tool does not change how engineers work. It reads Claude Code's existing conversation logs, which contain metadata (cwd, gitBranch, sessionId, timestamps) and the full message stream. It maintains a lightweight SQLite routing index that maps conversations to repos and branches and tracks read cursors. The spec pipeline is stateless: each update is a fresh `claude -p` call that reads the current spec from disk, combines it with new conversation excerpts, and produces an updated spec.

The tool was originally a daemon (global chokidar watcher firing spec updates on every JSONL change). It was rearchitected to a manual CLI with explicit token-spend control. Spec updates cost tokens — every `claude -p` call is a paid API invocation. The CLI model ensures tokens are spent only when the user explicitly invokes the tool or opts into watch mode for a specific branch.

## System Flow

### Core flow (shared across all modes)

```
derive | derive --reset | derive watch
  |
  v
detect context
  - cwd from process.cwd()
  - branch from git rev-parse --abbrev-ref HEAD (rejects detached HEAD)
  |
  v
discoverConversations(cwd, branch)
  1. query DB for conversations already known on this repo+branch
  2. list *.jsonl files in ~/.claude/projects/<slug>/
  3. for each file not in the known set:
     a. getConversation(id) — if exists (indexed for another branch), skip
     b. if null — readFromOffset(path, 0), extract gitBranch from first message
     c. upsert to DB (even for non-matching branches, to avoid re-reading)
  4. result: DB is reconciled; downstream functions query the now-complete index
  |
  v
mode dispatch
  |
  +-- [one-shot] runSpecUpdate(cwd, branch) → exit
  |
  +-- [--reset] resetBranch(cwd, branch) → exit
  |
  +-- [watch] runSpecUpdate(cwd, branch)
              then startWatcher(slugDir, debounced callback)
              callback: discoverConversations → runSpecUpdate
```

### Spec update pipeline (runSpecUpdate)

```
getConversationsForBranch(cwd, branch)
  → for each conversation: readFromOffset(jsonlPath, lastLineOffset)
    → advance offset immediately (crash safety)
  → batch all new messages
  → if no new messages: return
  → updateSpec(messages, specDir)
    → format messages as [type]: text excerpts
    → chunk excerpts at 300K chars if needed
    → for each chunk:
        readSpec(dir) → concat all .feature files into single string
        runClaude(SPEC_ROLE_PREAMBLE, prompt) → raw Gherkin
        reviewSpec(raw) → runClaude(REVIEW_SYSTEM_PROMPT, ...) → reviewed Gherkin
        writeSpec(dir, output) → rm *.feature, split by Feature: blocks, write per-feature files
  → upsertBranch(repoPath, branch, specDir)
```

### Reset pipeline (resetBranch)

```
if --keep-spec: preserve existing .feature files on disk
else: rm all *.feature files in specDir
resetConversationOffsets(cwd, branch) → zero all offsets in DB
for each conversation (sequentially):
  readFromOffset(jsonlPath, 0) → all messages
  updateSpec(messages, specDir, { skipReview: true }) → extraction only, writeSpec splits output
  advance offset
reviewSpecDir(specDir) → readSpec + single review pass + writeSpec on final accumulated spec
upsertBranch(repoPath, branch, specDir)
```

Sequential per-conversation processing avoids exceeding the prompt size limit — a lesson from early development where batching all conversations into one call caused "Prompt is too long" failures. The review pass is deferred to the end: intermediate specs only serve as context for the next extraction, so reviewing them is wasted work. When `--keep-spec` is used, the existing `.feature` files are preserved as starting context for the first conversation's reprocessing — useful when the spec contains hand-written content.

## Database Schema

SQLite database at `~/.machinen/machinen.db`. Uses `node:sqlite` `DatabaseSync` (synchronous API).

### conversations

| Column           | Type    | Constraints | Purpose                                              |
| ---------------- | ------- | ----------- | ---------------------------------------------------- |
| conversation_id  | TEXT    | PRIMARY KEY | Claude Code's session UUID (JSONL filename sans ext) |
| repo_path        | TEXT    | NOT NULL    | Absolute path to the git repository                  |
| branch           | TEXT    | NOT NULL    | Git branch name                                      |
| jsonl_path       | TEXT    | NOT NULL    | Absolute path to the JSONL file                      |
| last_line_offset | INTEGER | NOT NULL    | Line-based read cursor (0-indexed, total lines read) |
| updated_at       | TEXT    | NOT NULL    | ISO 8601 timestamp of last update                    |

### branches

| Column     | Type | Constraints              | Purpose                                |
| ---------- | ---- | ------------------------ | -------------------------------------- |
| repo_path  | TEXT | NOT NULL, PK (composite) | Absolute path to the git repository    |
| branch     | TEXT | NOT NULL, PK (composite) | Git branch name                        |
| spec_path  | TEXT | NOT NULL                 | Absolute path to the spec directory    |
| updated_at | TEXT | NOT NULL                 | ISO 8601 timestamp of last spec update |

The `branches` table is a lookup table — it records which spec directory belongs to which repo+branch combination. The `specPath` value is deterministic from `repoPath` (always `<repoPath>/.machinen/specs/`), but storing it provides a single query point for downstream tooling.

## Behaviour Spec

```gherkin
Feature: CLI spec update

  Scenario: Update spec for current branch
    Given the user is in a git repository on branch "feature-x"
    And Claude Code conversations exist for this repository and branch
    And some conversations have new messages since the last run
    When the user runs derive
    Then new messages are extracted from the conversations
    And the spec .feature files are updated with new behaviours
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
    Then all existing .feature files are deleted
    And all conversation offsets are zeroed
    And each conversation is processed sequentially from the start
    And the spec is fully regenerated as per-feature .feature files
    And the process exits

  Scenario: Reset with --keep-spec preserves existing spec
    Given the user is in a git repository on branch "feature-x"
    And .feature files exist with user-written content
    And conversations exist for this branch
    When the user runs derive --reset --keep-spec
    Then the existing .feature files are not deleted
    And all conversation offsets are zeroed
    And each conversation is reprocessed with the existing spec as starting context
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
    And the spec .feature files are updated with new behaviours

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

Feature: Multi-file spec storage

  Scenario: Spec output is split into per-feature files
    Given a derive run produces Gherkin with multiple Feature blocks
    When the spec is written to disk
    Then each Feature block is written to a separate .feature file in .machinen/specs/
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

  Scenario: Existing spec is used as starting point
    Given .feature files exist in .machinen/specs/ in the project
    When the user runs derive
    Then the existing spec content is concatenated and used as context for the update
    And the updated spec is split back into per-feature files

  Scenario: Iterative results are visible on disk
    Given a spec update involves multiple chunks
    When a chunk completes
    Then the intermediate result is written as split feature files
    And the next chunk reads the concatenated result back from disk
```

## Core Architecture

### Conversation reading

Claude Code stores conversations as JSONL files at `~/.claude/projects/<slugified_cwd>/<conversationId>.jsonl`. The slugified cwd is computed by replacing `/` with `-` in the absolute cwd path. Each line is a JSON record; `derive` only processes records with `type: "user"` or `type: "assistant"`.

Reading is incremental: the `lastLineOffset` cursor tracks the total line count already processed. On each run, `readFromOffset` streams the file, skips lines before the offset, and collects new user/assistant messages. The offset is advanced immediately after reading (before the Claude call), so a crash mid-update does not re-send the same messages.

### System tag stripping

Before extracting text, system-injected tags are stripped from message content:

- `<system-reminder>...</system-reminder>`
- `<ide_opened_file>...</ide_opened_file>`
- `<ide_selection>...</ide_selection>`

These carry no spec-relevant information and would pollute the extraction.

### Text extraction

Message content may be a plain string (older/simple messages) or an array of content blocks (current Claude API format). `extractText` handles both, filtering to `type: "text"` blocks and joining their text.

### Spec pipeline

The spec pipeline is stateless — each invocation is a fresh `claude -p` call. The pipeline consists of two passes:

**Pass 1 — Extraction.** Messages are formatted as `[type]: text` excerpts, separated by `---`. If the total exceeds 300K characters, excerpts are split into chunks and processed sequentially (each chunk reads the spec back from disk via `readSpec` — which concatenates all `.feature` files — as updated by the previous chunk's `writeSpec`). The system prompt (`SPEC_ROLE_PREAMBLE`) instructs the agent to extract testable product behaviours and output Gherkin. It enforces a black-box test: every scenario must be verifiable by someone who can only use the product's external interfaces.

**Pass 2 — Review.** The raw Gherkin is reviewed by a second `claude -p` call with a review system prompt (`REVIEW_SYSTEM_PROMPT`). This pass performs four operations in order: (1) filter — remove scenarios that fail the black-box test, (2) deduplicate — merge scenarios that describe the same observable behaviour under different names, (3) consolidate — when the same invariant appears across multiple Features, keep it in the most natural location and remove duplicates, (4) simplify — remove scenarios whose assertions are already fully encoded in another scenario. The review pass can be skipped via `{ skipReview: true }` — used by reset mode to defer review to the end, since intermediate specs only serve as context for subsequent extractions. `reviewSpecDir(dir)` provides a standalone entry point for the deferred review — it calls `readSpec` to concatenate, reviews, then `writeSpec` to split back.

**Spec I/O virtualization.** The LLM pipeline operates on a single concatenated string — it has no awareness of file boundaries. `readSpec(dir)` globs `*.feature` files in the spec directory, sorts alphabetically, and concatenates their contents. `writeSpec(dir, gherkin)` parses the output by `Feature:` blocks, slugifies each feature name (lowercase, non-alphanumeric runs replaced with `-`, trimmed), removes all existing `.feature` files, and writes each block to `<slug>.feature`. This rm-before-write is safe because the content was already consumed by the LLM and re-expressed in its output.

Both passes use `execa` to spawn `claude -p` with `--model sonnet --output-format stream-json --verbose --include-partial-messages --tools "" --effort low --no-session-persistence`. Tools are disabled because both passes receive all input via stdin and only produce text. Effort is set to low because these are well-specified text transformations, not open-ended reasoning. The stream-json output provides a structured activity log: `[claude] thinking:` with progress dots for thinking blocks, `[claude] tool_use: ToolName(input)` for tool calls (a safety-net indicator — should not appear with tools disabled), and `[claude] generating text` with dots for text output. A short, fixed `--system-prompt` override replaces the default system prompt (suppressing inherited style instructions). The detailed role instructions (preamble) and the data prompt are both piped via `stdin` (`input:` option) to avoid OS arg length limits on the CLI arg. `extendEnv: false` and `delete env.CLAUDECODE` prevent Claude Code from recursing into itself. When `derive` itself is invoked with `--verbose`, the raw NDJSON events are also dumped to stdout (truncated at 500 chars) for debugging the stream structure.

### DB-first discovery

Discovery reconciles the SQLite index with the filesystem. It queries the DB for conversations already known on the target branch, lists JSONL files in the slug directory, and reads only truly new files to extract their `gitBranch` field. Non-matching branches are still indexed to avoid redundant file reads on future invocations. After discovery, downstream functions (`runSpecUpdate`, `resetBranch`) query the now-complete DB.

### Watch mode

`derive watch` is a thin loop around the core flow. It runs an initial `discoverConversations` + `runSpecUpdate`, then starts a chokidar watcher on the slug directory. The watcher fires on `add` and `change` events for `*.jsonl` files, debounced at 5 seconds. Each debounced callback re-runs discovery and spec update for the current branch only.

The watcher uses `ignoreInitial: true` (the initial cycle is explicit), `awaitWriteFinish` (500ms stability threshold) for partial-write safety, and an `ignored` callback that filters out non-JSONL files.

## API Reference (CLI)

| Command                      | Description                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `derive`                     | One-shot update. Discover conversations, read new messages, update spec, exit.                                           |
| `derive --reset`             | Regenerate spec from scratch. Delete .feature files, zero offsets, reprocess all conversations sequentially, exit.       |
| `derive --reset --keep-spec` | Reprocess all conversations from scratch, but preserve the existing .feature files as starting context.                  |
| `derive watch`               | Run an initial update, then watch for conversation changes on the current branch. Re-runs on changes (debounced).        |
| `derive --scope <name>`      | Direct specs to a subdirectory: `.machinen/specs/<name>/*.feature`. Combinable with other flags.                         |
| `derive --verbose`           | Enable verbose output. Dumps raw NDJSON events from spawned claude processes for debugging. Combinable with other flags. |

All commands infer the repository path from `process.cwd()` and the branch from `git rev-parse --abbrev-ref HEAD`. The tool is invoked via `pnpm --filter derive start` (or `pnpm --filter derive start -- <args>`).

## Requirements, Invariants & Constraints

- **Explicit token spend.** Tokens are only spent when the user invokes `derive`, `derive --reset`, or opts into `derive watch`. No silent background consumption.
- **Branch-scoped watch.** `derive watch` only watches and updates the current branch. Conversations for other branches in the same slug directory are ignored.
- **DB-first discovery.** Known conversations come from SQLite first. Only truly unknown JSONL files trigger a file read for branch detection.
- **Branch from git.** Determined by `git rev-parse --abbrev-ref HEAD`. Detached HEAD is rejected with a non-zero exit code.
- **cwd is repoPath.** `process.cwd()` serves as the repository path, consistent with Claude Code's own convention.
- **Exact cwd slug match.** Only conversations in `~/.claude/projects/<slugified_cwd>/` are discovered. Conversations from subdirectories of the same repo (different cwd, different slug) are not included.
- **Offset semantics.** `lastLineOffset` is the total number of lines read (0-indexed start). Offsets are advanced before the Claude call (crash safety).
- **Spec pipeline is stateless.** No `--resume`. The spec files on disk are the state. Each `claude -p` call reads the current spec (concatenated from `.feature` files) and produces an updated one.
- **Sequential reset.** Reset mode processes each conversation in a separate `updateSpec` call to avoid exceeding prompt size limits.
- **Project-local specs.** Spec files live at `<repoPath>/.machinen/specs/*.feature` (or `<repoPath>/.machinen/specs/<scope>/*.feature` when `--scope` is used), one per `Feature:` block. They travel with the branch via git.
- **Optional scope.** `--scope <name>` appends a subdirectory to the spec path, allowing specs to be organized by domain (e.g., `--scope derive` → `.machinen/specs/derive/`). When omitted, specs go directly into `.machinen/specs/`.
- **Virtualized file boundary.** The LLM pipeline operates on a single concatenated string. `readSpec` concatenates all `.feature` files; `writeSpec` splits the output by `Feature:` blocks and writes per-feature files. A `Feature:` block maps 1:1 to a `.feature` file.
- **Deterministic read order.** `.feature` files are sorted alphabetically by filename when concatenated, ensuring deterministic input to the LLM.
- **Clean-slate write.** `writeSpec` removes all existing `.feature` files before writing new ones. This is safe because the content was already consumed and re-expressed by the LLM.
- **Existing spec as implicit context.** `updateSpec` reads the spec from disk if it exists. `.feature` files committed on the branch (or created manually by the user) become the starting context with no additional logic.
- **Claude recursion prevention.** `extendEnv: false` and `delete env.CLAUDECODE` prevent the spawned `claude -p` process from detecting a parent Claude Code session and recursing.
- **No tools, low effort, Sonnet model.** Spawned `claude -p` calls use `--model sonnet`, `--tools ""` (no built-in tools), and `--effort low` (minimal thinking). Both passes are text-in/text-out transformations that receive all context via stdin — Opus-level reasoning is unnecessary.
- **No session persistence.** Spawned `claude -p` calls use `--no-session-persistence` to prevent writing JSONL session files. Without this, each spawned call creates a session file in the same slug directory, which gets discovered as a "conversation" on the next run — creating a feedback loop of ghost conversations.
- **Node >= 22.5.** Required for `node:sqlite` `DatabaseSync`.

## Learnings & Anti-Patterns

### Prompt size limits require sequential processing

Batching all conversations into a single `updateSpec` call can exceed Claude's prompt size limit. Reset mode processes each conversation in its own `updateSpec` call, where each call reads the spec back from disk (as updated by the previous call). This sequential strategy was discovered during the original development when "Prompt is too long" errors occurred.

### Two-pass review is necessary

A single-pass extraction produces Gherkin that often includes implementation-detail scenarios (internal function calls, database schemas, env var handling) and redundant scenarios that describe the same behaviour under different names. The second pass (review) with a dedicated system prompt addresses both problems: it filters implementation details via the black-box test, then deduplicates, consolidates cross-feature overlaps, and simplifies subset scenarios. Attempting to handle these concerns in the extraction prompt alone was insufficient.

### The black-box test is the quality heuristic

Every scenario must pass the black-box test: "Could a QA engineer verify this using only the product's external interfaces?" This is enforced in both system prompts (extraction and review). It provides a concrete, repeatable standard for what belongs in the spec.

### Claude Code slugification

Claude Code computes the slug directory by replacing both `/` and `_` with `-` in the absolute cwd path. For example, `/Users/justin/rw/worktrees/machinen_specs` becomes `-Users-justin-rw-worktrees-machinen-specs`. This was discovered empirically — the original assumption was that only `/` was replaced, which caused discovery to miss conversations for cwds containing underscores.

### awaitWriteFinish prevents partial reads

Claude Code appends to JSONL files incrementally. Without chokidar's `awaitWriteFinish`, file-change events can fire mid-write, causing `readFromOffset` to parse incomplete JSON lines. A 500ms stability threshold resolves this.

### System tags pollute extraction

Claude Code injects `<system-reminder>`, `<ide_opened_file>`, and `<ide_selection>` tags into conversation records. These carry no behavioural intent and, if left in, cause the extraction agent to produce irrelevant scenarios about IDE state. They are stripped before text extraction.

### Ghost conversations from session persistence

By default, `claude -p` persists session JSONL files in the same slug directory as the parent process. When derive spawns `claude -p` calls, these ghost files appear alongside real conversations and get discovered as "conversations" on the next `--reset` run. Each reset creates more ghost files, compounding the problem. Adding `--no-session-persistence` to all `claude -p` calls prevents this. Ghost files can be identified by grepping for "spec-maintenance agent" (the extraction preamble) in the JSONL content.

### CLAUDECODE env var causes recursion

When `claude -p` is spawned from within a Claude Code session, the child process inherits the `CLAUDECODE` environment variable and attempts to connect back to the parent. Setting `extendEnv: false` and deleting `CLAUDECODE` from the spawned env prevents this.

## Directory Mapping

```
derive/
  package.json          — package metadata, scripts (start, typecheck), dependencies (chokidar, execa)
  tsconfig.json         — TypeScript config (module: NodeNext, target: ES2022, strict)
  src/
    index.ts            — CLI entry point: context detection, discovery, mode dispatch (one-shot/reset/watch)
    watcher.ts          — branch-scoped chokidar watcher (watches single slug dir, *.jsonl filter, awaitWriteFinish)
    db.ts               — SQLite routing index (conversations + branches tables, CRUD operations)
    reader.ts           — JSONL reader (incremental offset-based reading, system tag stripping, text extraction)
    spec.ts             — spec pipeline (two-pass Gherkin: extraction + review, 300K chunking, claude -p via execa, stream-json activity log, readSpec/writeSpec I/O virtualization)
    types.ts            — shared types (JsonlMessage, ConversationRecord, BranchRecord)
```

Spec files are written to `<repoPath>/.machinen/specs/<feature-slug>.feature` (project-local, not in the derive package). One file per `Feature:` block, named by slugifying the feature name.

The SQLite database lives at `~/.machinen/machinen.db` (global, shared across projects).
