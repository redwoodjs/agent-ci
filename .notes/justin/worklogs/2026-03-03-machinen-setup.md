# Worklog: Machinen — Initial TypeScript Project Setup

## Context / Brief

We are building a lightweight local orchestration layer called Machinen. Its purpose is to sit alongside Claude Code and help us maintain a living behaviour spec per git branch. The core idea is simple: engineers are already using Claude Code to build features on branches. Those conversations implicitly contain the evolving intent of the feature. We want to capture that intent and maintain a structured spec that reflects what the branch is supposed to do — without changing how engineers work.

Claude Code stores conversations locally as JSONL files. These files contain useful metadata such as cwd, gitBranch, sessionId (which we refer to as conversationId), timestamps, and the full message stream. That means we do not need to infer branch or repository state ourselves. We can read it directly from the conversation logs.

Claude conversation files live under:

~/.claude/projects/<slugified_dir_path>/<conversation_id>.jsonl

For example:

/Users/justin/.claude/projects/-Users-justin-rw-sdk/16eeb8a5-f024-4a26-ab00-5b9d3acc3aa8.jsonl

The <slugified_dir_path> corresponds to the working directory of the project (derived from cwd), and each <conversation_id>.jsonl file contains the full append-only log of that conversation.

We treat these files as the source of truth. Machinen does not duplicate conversation content into its own store. Instead, it maintains only minimal lookup state: which Claude conversations belong to which repo and branch, and which spec file corresponds to that branch.

The basic mental model is:
• Each git branch has:
• A set of Claude conversations associated with it (feature-building conversations).
• A spec file maintained by Machinen.
• A dedicated Claude conversation used exclusively for maintaining the branch spec.

Machinen runs locally as a small daemon. It watches the Claude projects directory:

~/.claude/projects/\*\*

When a conversation file changes, Machinen reads new lines and extracts minimal metadata: conversation ID, repository path (from cwd), and branch name (from gitBranch). Using that information, it records a simple mapping: this conversation ID belongs to this repo and this branch.

We only store the mapping from branch to conversation IDs. We do not store the full message content. When we need to update a spec, we open the relevant JSONL files directly and extract the necessary conversation content on demand.

Specs are stored locally in a deterministic location:

~/.machinen/specs/<repo>/<branch>.md

The spec file is a first-class artifact. It is human-readable and durable. Machinen treats it as the canonical behaviour specification for that branch.

For each branch, Machinen programmatically creates and maintains a dedicated “spec maintenance” conversation using the claude CLI. This conversation is started automatically the first time we initialise a spec for that branch. We invoke the claude CLI programmatically, providing an initial system prompt that establishes its role: it is responsible for maintaining the behavioural specification of this branch based on development conversations.

We store the conversation ID of this spec-maintenance conversation alongside the branch mapping. From then on, whenever new relevant information comes to light — meaning new Claude conversations associated with that branch — Machinen gathers the relevant excerpts and sends them into this existing spec conversation using the claude CLI. This allows the spec-maintenance conversation to evolve incrementally, preserving context across revisions.

The flow for maintaining a spec is: 1. Identify the repo and branch. 2. Look up all Claude conversation IDs associated with that branch. 3. Open the corresponding files at:

~/.claude/projects/<slugified_dir_path>/<conversation_id>.jsonl

    4.	Extract relevant user and assistant messages.
    5.	Send those excerpts to the branch’s dedicated spec-maintenance conversation via the claude CLI, instructing it to revise the spec in light of new information.
    6.	Write the updated spec content to:

~/.machinen/specs/<repo>/<branch>.md

The spec-maintenance conversation is long-lived. It accumulates understanding of the branch over time. We do not create a new conversation per revision; we append to the same one, allowing it to refine and stabilise the specification as the feature evolves.

The SQLite database exists only to maintain simple lookup mappings between:
• repo + branch → feature conversations
• repo + branch → spec file path
• repo + branch → spec-maintenance conversation ID

It is not a canonical store of conversations. It is only a routing and indexing layer.

This architecture keeps the system small and robust:
• Claude conversation files remain the source of truth.
• Specs remain explicit, durable artifacts.
• The spec-maintenance conversation is explicitly owned and managed.
• No duplication of conversation data.
• No inference logic for branch detection.
• No heavy data modeling or migrations.

Machinen is therefore a thin coordination layer between git branches, Claude conversations, and a living behavioural spec that is maintained programmatically over time.

---

## Investigated the JSONL conversation file format

We opened an actual claude conversation file at `~/.claude/projects/-Users-justin-rw-worktrees-machinen-experiments-specs/66d813b0-...jsonl` and extracted its structure.

Record types observed:

- `queue-operation` — internal claude queue bookkeeping, not useful to us
- `file-history-snapshot` — file backup snapshots, not useful to us
- `user` — a user turn
- `assistant` — an assistant turn

The `user` and `assistant` records carry the fields we care about directly on the record (not nested):

- `sessionId` — the conversation ID (maps to the filename)
- `cwd` — the working directory (from which we can derive the repo)
- `gitBranch` — the branch name at the time of the message
- `type` — "user" or "assistant"
- `message.role` — "user" or "assistant"
- `message.content` — array of content blocks, each with `type` and `text`

The file path convention is:

```
~/.claude/projects/<slugified_cwd>/<sessionId>.jsonl
```

Where `slugified_cwd` replaces `/` with `-` (e.g. `/Users/justin/rw/sdk` → `-Users-justin-rw-sdk`).

---

## Investigated the claude CLI

The Claude CLI at `~/.local/bin/claude` supports the following key flags relevant to Machinen:

- `-p, --print` — non-interactive mode, prints response and exits. Essential for programmatic use.
- `-r, --resume <uuid>` — resume an existing conversation by its session ID. This is how we feed incremental updates to the spec-maintenance conversation.
- `--system-prompt <prompt>` — set a system prompt for the session. Used when initialising a new spec-maintenance conversation.
- `--output-format <format>` — `text`, `json`, or `stream-json`. We will use `json` for structured output.
- `--session-id <uuid>` — force a specific UUID for the new session. Useful to pre-assign an ID and store it in our DB.

The core programmatic flow for spec maintenance is therefore:

1. **First time**: `claude --print --system-prompt "..." "Initial context..."` → capture returned session ID and store.
2. **Subsequent**: `claude --print --resume <stored_session_id> "New excerpts, please update the spec"` → spec-maintenance conversation accumulates understanding incrementally.

---

## RFC: Machinen TypeScript Project — Initial Structure

### 2000ft View Narrative

Machinen includes a local daemon that watches Claude conversation files and maintains a living behavioural spec per git branch. It reads the claude JSONL logs as the source of truth, stores only a minimal routing index in SQLite, and drives spec updates programmatically via the claude CLI.

We are scaffolding the initial TypeScript project in `specs/` as the root. The project is deliberately small. It should be runnable with `tsx` for development and type-checked with `tsc`. No build step is required for local use.

The key concern at this stage is laying down a clean, well-typed skeleton with clear module boundaries, so that each subsystem (watching, indexing, reading, spec maintenance) can be built and tested independently.

### Behaviour Spec

```
GIVEN the daemon is running
WHEN a .jsonl file in ~/.claude/projects/**/ is modified
THEN Machinen reads any new lines
AND extracts sessionId, cwd, gitBranch from user/assistant records
AND upserts a conversation→branch mapping in SQLite

GIVEN a branch has new conversations indexed
WHEN a spec update is triggered
THEN Machinen reads the full message content from the relevant JSONL files
AND sends excerpts to the branch's spec-maintenance conversation via claude CLI
AND writes the updated spec to ~/.machinen/specs/<repo>/<branch>.md

GIVEN a branch has no spec-maintenance conversation yet
WHEN a spec update is triggered for the first time
THEN Machinen creates a new conversation via claude CLI with a system prompt establishing its role
AND stores the resulting session ID in SQLite for future updates
```

### Database Schema (SQLite)

```sql
-- Maps conversation IDs to repo+branch
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id   TEXT PRIMARY KEY,
  repo_path         TEXT NOT NULL,
  branch            TEXT NOT NULL,
  jsonl_path        TEXT NOT NULL,
  last_line_offset  INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
);

-- Maps repo+branch to spec metadata
CREATE TABLE IF NOT EXISTS branches (
  repo_path              TEXT NOT NULL,
  branch                 TEXT NOT NULL,
  spec_path              TEXT NOT NULL,
  spec_conversation_id   TEXT,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (repo_path, branch)
);
```

### Implementation Breakdown

```
[NEW] specs/package.json                 — project manifest, deps, scripts
[NEW] specs/tsconfig.json                — TypeScript config (ESNext, module Node)
[NEW] specs/src/types.ts                 — shared types (ConversationRecord, BranchRecord, JsonlMessage)
[NEW] specs/src/db.ts                    — SQLite layer using better-sqlite3 (init schema, upsert/query helpers)
[NEW] specs/src/reader.ts               — JSONL reader: stream a file from an offset, extract user+assistant messages
[NEW] specs/src/watcher.ts              — chokidar watcher for ~/.claude/projects/**/*.jsonl
[NEW] specs/src/spec.ts                 — spec maintenance: invoke claude CLI to create/update spec conversations
[NEW] specs/src/index.ts                — daemon entry point: wire up watcher → db → spec
```

### Directory & File Structure

```
specs/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts       # daemon entry point
    ├── types.ts       # shared types
    ├── db.ts          # SQLite routing index
    ├── reader.ts      # JSONL file reader / extractor
    ├── watcher.ts     # chokidar file watcher
    └── spec.ts        # spec maintenance via claude CLI
```

### Types & Data Structures

```typescript
// A parsed line from a JSONL conversation file (user or assistant type only)
type JsonlMessage = {
  type: "user" | "assistant";
  sessionId: string;
  cwd: string;
  gitBranch: string;
  timestamp?: string;
  message: {
    role: "user" | "assistant";
    content: Array<{ type: string; text?: string }>;
  };
};

// A row in the conversations table
type ConversationRecord = {
  conversationId: string;
  repoPath: string;
  branch: string;
  jsonlPath: string;
  lastLineOffset: number;
  updatedAt: string;
};

// A row in the branches table
type BranchRecord = {
  repoPath: string;
  branch: string;
  specPath: string;
  specConversationId: string | null;
  updatedAt: string;
};
```

### Key Dependencies

| Package                 | Role                                      |
| ----------------------- | ----------------------------------------- |
| `chokidar`              | File watching                             |
| `better-sqlite3`        | SQLite (sync, no promise overhead needed) |
| `@types/better-sqlite3` | Types for above                           |
| `tsx`                   | Run TypeScript directly in development    |

### Invariants & Constraints

- We never store full conversation content in the DB — only metadata and offsets.
- We read JSONL files from the stored `lastLineOffset`, not from the start, to handle large files efficiently.
- The spec-maintenance conversation is identified by a stored session ID. We never create a second one for the same branch.
- Spec files live under `~/.machinen/specs/<repo_slug>/<branch>.md`.
- The watcher ignores files that are not `.jsonl`.
- We only process `type: "user"` and `type: "assistant"` records; all other record types are skipped.

### Suggested Verification

After scaffolding:

```bash
cd specs/
npm install
npx tsc --noEmit   # should pass cleanly
npx tsx src/index.ts  # should start and log "Machinen daemon started"
```

### Tasks

- [x] Create `specs/package.json`
- [x] Create `specs/tsconfig.json`
- [x] Create `specs/src/types.ts`
- [x] Create `specs/src/db.ts`
- [x] Create `specs/src/reader.ts`
- [x] Create `specs/src/watcher.ts`
- [x] Create `specs/src/spec.ts`
- [x] Create `specs/src/index.ts`

---

## Switched SQLite backend from better-sqlite3 to node:sqlite

`better-sqlite3@9.6.0` failed to compile against Node 24.10.0 — C++ concepts syntax in the Node 24 V8 headers is incompatible with the version of clang it was invoking during `node-gyp rebuild`. Error: `unknown type name 'concept'`.

We dropped `better-sqlite3` and its type package from `package.json`, and rewrote `db.ts` to use the built-in `node:sqlite` module (available without flags from Node 22.13+, fully present in Node 24). The API surface is identical: synchronous `DatabaseSync`, `db.exec()`, `db.prepare().run()/.get()/.all()`. No native build step required.

Updated `engines.node` to `>=22.5` (the earliest Node with `node:sqlite`).

## Fixed stdin piping in spec.ts

`execFile` (and its promisified form) does not accept an `input` option in its types — that option only exists on `exec`. Since we want to pipe large conversation excerpts to `claude` via stdin (to avoid command-line arg length limits), we switched to `spawn` with `stdio: ['pipe', 'pipe', 'pipe']` and write directly to `child.stdin`.

## Verified typecheck passes

`pnpm typecheck` exits cleanly with no errors.

---

## Fixed watcher: chokidar v4 removed glob support

chokidar v4 README explicitly states it "removes support for globs". The original glob pattern `~/.claude/projects/**/*.jsonl` was silently not working.

Fixed by watching the directory directly (`CLAUDE_PROJECTS_DIR`) and using the `ignored` callback to filter out non-`.jsonl` files:

```ts
ignored: (filePath, stats) => stats?.isFile() === true && !filePath.endsWith(".jsonl"),
```

chokidar calls `ignored` with a `stats` argument when available; when `stats` is undefined (directory entries), we allow them through so chokidar recurses into subdirectories. Only files that don't end in `.jsonl` are excluded.

---

## Fixed content.filter crash + added diagnostic logging

Two runtime errors observed when running against real data:

**1. `TypeError: message.message.content.filter is not a function`**

Our `JsonlMessage` type declared `content` as `Array<...>`, but in practice the field may not always be an array (older conversation files or simple messages may store content as a plain string). The type was updated to `string | Array<...>` and `extractText` now handles both cases. When an unexpected type is encountered, it logs a warning with the message type, session ID, and the raw content value before returning an empty string.

**2. `claude CLI returned empty result for spec update`**

The claude CLI returned an empty response for the `renovate-groups` branch. Root cause not yet determined — the only conversation on that branch contained an assistant message "Credit balance is too low", so the spec update was called with minimal content. Added logging around every `runClaude` invocation to make this diagnosable.

**Logging added:**

- `spec.ts / runClaude`: logs args and prompt char count before spawn; logs stderr as a warning on both success and failure; logs result char count on success.
- `spec.ts / updateSpec`: logs message count and excerpt char count before invoking claude.
- `index.ts / runSpecUpdate`: logs per-conversation offset delta and new message count.
- `reader.ts / extractText`: warns with content type and value when shape is unexpected.

---

## Ran probe scripts to isolate the empty-output bug (2026-03-03)

Resumed investigation into why `claude CLI returned empty result for spec update`. Four probe scripts existed:

- `probe-stdin.mjs` — tests whether claude reads prompts from stdin vs positional arg
- `probe-resume.mjs` — tests `--resume` with both stdin and positional arg
- `probe-system-prompt.mjs` — isolates `--system-prompt` + `--session-id` combos
- `probe-spec-patterns.mjs` — replicates the exact `createSpecConversation` + `updateSpec` call patterns end-to-end

### Findings

**probe-stdin.mjs**: All three tests passed. Stdin works. Positional arg works. When both are provided, claude runs them as two sequential turns (both responses returned concatenated). Not a bug in our case since we only use one or the other.

**probe-system-prompt.mjs**: All seven tests passed — single-line, multiline, with/without `--session-id`, stdin and positional arg. No issue here.

**probe-resume.mjs**: Both `--resume` + arg and `--resume` + stdin work correctly. Session created and resumed without issue.

**probe-spec-patterns.mjs**: **Root cause found.** Step 1 (`createSpecConversation` pattern) exits with code 0 but returns stdout of exactly `"\n"` — one newline, nothing else. The spec-maintenance system prompt is being passed via `--system-prompt` alongside `--session-id`, with the init prompt written to stdin. Exit code 0, no stderr, but empty (blank line) output.

Because Step 1 returns empty output, `probe-spec-patterns.mjs` aborts and Step 2 (`updateSpec` / `--resume`) is never reached. So we do not yet have evidence that `--resume` itself is broken — Step 1 is the failure point.

### Hypothesis

The combination of `--system-prompt` (multiline, ~400 char) + `--session-id` + prompt via **stdin** appears to produce empty output. Notably, `probe-system-prompt.mjs` Test 6 (multiline system prompt + session-id + stdin) passed fine with a short prompt ("Say exactly: MULTILINE_SESSIONID_STDIN_OK"). The difference in `probe-spec-patterns.mjs` is:

1. The system prompt is substantially longer (~400 chars vs ~50 chars).
2. The system prompt contains explicit instructions to "Output ONLY the updated spec in Markdown format" — this may interact with the init prompt producing a skeleton that evaluates to blank/empty in a way the model considers valid.
3. The init prompt asks for "an empty spec skeleton" — the model may be outputting a blank response as a literal interpretation.

The most likely explanation: the init prompt says "No conversation data yet — output an empty spec skeleton." The model is outputting a literally empty (or near-empty) skeleton — just a newline — which is technically compliant with the instruction. This is a prompt design issue, not a CLI mechanics issue.

### Next Step

Revise `createSpecConversation` init prompt to ensure non-empty output (e.g., ask for a skeleton with placeholder headings rather than an "empty" one). Confirm by re-running `probe-spec-patterns.mjs` with a patched prompt.

---

## Replaced spawn with execa (2026-03-03)

The `spawn` + manual stdin piping approach in `runClaude` was the root of the problem. Rather than debug edge cases around stdin vs positional arg handling, we replaced the entire mechanism with `execa`.

### What changed

1. **Removed `spawn`**: Dropped `node:child_process` import entirely.
2. **Added `execa`**: `pnpm add execa` (v9.6.1). Prompt is now passed as a positional arg to `claude -p <prompt>`.
3. **Stripped `CLAUDECODE` env var**: The claude CLI refuses to run inside an active Claude Code session (exits 1 with "Nested sessions share runtime resources"). We `delete env.CLAUDECODE` before passing env to execa. Discovered during probe investigation — all probes failed with exit 1 until this was addressed.
4. **Updated init prompt**: Changed from "output an empty spec skeleton" to "output a spec skeleton with placeholder headings" to avoid the model returning a literally blank response.
5. **Removed all probe files**: `probe-stdin.mjs`, `probe-resume.mjs`, `probe-system-prompt.mjs`, `probe-spec-patterns.mjs`.

### Key insight

The `spawn` + stdin approach was fragile because the claude CLI's stdin handling depends on how it interacts with `--print`, `--system-prompt`, and `--session-id` in combination. Passing the prompt as a simple positional arg (like `claude -p "the prompt"`) is what the CLI is designed for and avoids all these edge cases.

### Typecheck

`pnpm typecheck` passes cleanly.

---

## Discovered `--resume` + `-p` hangs the claude CLI (2026-03-03)

We confirmed through manual testing that combining `--resume <session_id>` with `-p` (print mode) causes the claude CLI to hang silently until killed. This affects our `updateSpec` function at `spec.ts:76`, which currently does:

```ts
const result = await runClaude(["--resume", specConversationId], prompt);
```

This expands to `claude --resume <id> -p <prompt>`, which hangs indefinitely.

### What we tested

1. Created a new session manually via the CLI.
2. Attempted `claude --resume <session_id> -p "some prompt"` — hangs silently, produces no output, must be killed.
3. `claude --resume <session_id>` without `-p` opens an interactive session (works, but not suitable for programmatic use since we are not a tty).

### Impact

The `updateSpec` flow (feeding incremental conversation excerpts into the spec-maintenance conversation) is broken. The initial `createSpecConversation` works because it uses `--session-id` (not `--resume`), but all subsequent updates that rely on `--resume` will hang.

### Current status

Investigating alternatives. Options under consideration:

- `--continue` flag (resumes most recent conversation, but does not accept a session ID — not suitable).
- Piping to stdin with `--resume` (without `-p`), though we are not a tty.
- Alternative API/SDK-based approaches instead of CLI.
- Other CLI flags or modes we have not yet explored.

---

## Researched `--resume` + `-p` bug history and alternatives (2026-03-03)

### Claude CLI version

We are running Claude Code **2.1.63**, well past the August 2025 fix window.

### Bug history

The `--resume` + `-p` combination was a **confirmed bug** — GitHub issue [#3976](https://github.com/anthropics/claude-code/issues/3976), filed July 2025, fixed August 2025. The reporter described the same symptom: Claude loses awareness of previous messages when resuming in print mode. The fix was applied by an Anthropic collaborator.

Separate hanging issues exist that are **not specific to `-p`**:

- [#9844](https://github.com/anthropics/claude-code/issues/9844): `--resume` hangs the terminal entirely.
- [#22204](https://github.com/anthropics/claude-code/issues/22204): `/resume` hangs with large session history (~734MB).
- [#24478](https://github.com/anthropics/claude-code/issues/24478): CLI freezes after ~10 minutes; `--resume` hangs on "Resuming conversation."

Since we are on v2.1.63 (post-fix), our hang is likely either a regression or falls into the category of these separate hanging issues. We have not yet measured the size of our session state.

### Documented CLI approach for resume

The [headless mode docs](https://code.claude.com/docs/en/headless) confirm the intended pattern:

```bash
# Capture session ID from first invocation
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')

# Resume that specific session
claude -p "Continue that review" --resume "$session_id"
```

One caveat noted in issue #3976: the session ID may change between invocations. We should capture the most recent session ID from each response via `--output-format json`, not reuse the original indefinitely. Unclear whether this is still true post-fix.

### Alternative: Claude Agent SDK

The **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) is the purpose-built programmatic interface. It provides native session management without spawning CLI processes.

**V1 API (stable)**:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Create session, capture ID
for await (const message of query({
  prompt: "...",
  options: { model: "claude-opus-4-6" }
})) {
  if (message.type === "system" && message.subtype === "init") {
    sessionId = message.session_id;
  }
}

// Resume later
for await (const message of query({
  prompt: "...",
  options: { resume: sessionId }
})) { ... }
```

**V2 API (preview, simpler)**:

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";

await using session = unstable_v2_createSession({ model: "claude-opus-4-6" });
await session.send("...");
// Later:
await using resumed = unstable_v2_resumeSession(sessionId, { model: "..." });
```

Key advantages over CLI: single long-lived process, structured error handling, native async generators, no stdin/stdout parsing, automatic session ID management.

**However**: the SDK requires `ANTHROPIC_API_KEY` (direct API billing), whereas the CLI uses the Claude subscription. This is a meaningful cost/auth difference.

### Assessment

Three paths forward:

1. **Debug the CLI hang** — try `--output-format json` with `--resume` + `-p` to see if the hang is specific to text output. Check session file sizes. May be a quick fix if it is a known edge case.
2. **Rearchitect around stateless calls** — drop the long-lived spec-maintenance conversation entirely. Each `updateSpec` call would send the full current spec + new excerpts, asking Claude to produce an updated spec. No `--resume` needed; every call is a fresh `-p` invocation. Trades conversation context for simplicity and reliability.
3. **Switch to Claude Agent SDK** — native session management, but introduces API key dependency and direct API billing.

Awaiting alignment on which direction to pursue.

---

## Decision: rearchitect around stateless calls (2026-03-03)

We chose **option 2** — drop the long-lived spec-maintenance conversation entirely and rearchitect around stateless `-p` calls.

### Rationale

- The `--resume` + `-p` combination is unreliable (hangs on v2.1.63 despite a prior fix).
- A stateless approach eliminates the entire class of session-management bugs.
- The spec file itself already captures accumulated understanding — we can feed it back as context on each call instead of relying on conversation history.
- No new dependencies (Agent SDK) or billing model changes (API key) required.

### Design

Each `updateSpec` call becomes a fresh `claude -p` invocation that receives:

1. The current spec file contents (if it exists).
2. The new conversation excerpts.
3. A prompt instructing Claude to produce the updated spec.

This means `createSpecConversation` is no longer needed — there is no spec conversation to create or resume. The `specConversationId` field in the DB and the `--resume` / `--session-id` code paths can be removed.

The system prompt and update prompt fold into a single prompt template used on every call.

### RFC: Stateless spec update

#### 2000ft View

We remove the concept of a persistent spec-maintenance conversation. Instead of `--resume`-ing a long-lived session, each spec update is a self-contained `claude -p` call. The current spec (read from disk) provides continuity between calls — Claude sees what the spec looks like now, sees the new excerpts, and produces a revised spec. The spec file is the state, not the conversation.

#### Behaviour Spec

```
GIVEN a branch has new conversation excerpts
AND a spec file already exists for that branch
WHEN updateSpec is called
THEN a fresh claude -p call is made with the current spec + new excerpts
AND the result replaces the spec file on disk

GIVEN a branch has new conversation excerpts
AND no spec file exists yet
WHEN updateSpec is called
THEN a fresh claude -p call is made with only the new excerpts
AND the result is written as the initial spec file
```

#### Implementation Breakdown

```
[DELETE] createSpecConversation()         — no longer needed
[DELETE] --resume / --session-id usage    — no session management
[MODIFY] updateSpec()                     — read current spec from disk, build self-contained prompt, single fresh -p call
[MODIFY] runClaude()                      — simplify args (no --resume, --session-id, --system-prompt)
[MODIFY] index.ts                         — remove specConversationId creation/storage logic
[MODIFY] db.ts (if applicable)            — drop spec_conversation_id column from branches table
```

#### Invariants

- Every `updateSpec` call is idempotent given the same spec file + excerpts.
- The spec file on disk is the only state between calls.
- No session IDs are stored or managed for spec maintenance.

#### Tasks

- [x] Remove `createSpecConversation` and session ID logic from `spec.ts`
- [x] Rewrite `updateSpec` to read current spec from disk and build a self-contained prompt
- [x] Update `index.ts` to remove spec conversation creation
- [x] Remove `spec_conversation_id` from DB schema/queries and types
- [x] Verify typecheck passes

---

## Implemented stateless spec update (2026-03-03)

All tasks complete. `pnpm typecheck` passes cleanly.

### What changed

**`spec.ts`**: Removed `createSpecConversation`, `randomUUID` import, and the `SPEC_SYSTEM_PROMPT` constant. `runClaude` signature simplified from `(args, prompt)` to `(prompt)` — it now always does a bare `claude -p <prompt>` with no session flags. `updateSpec` signature changed from `(specConversationId, messages, sPath)` to `(messages, sPath)`. It reads the current spec from disk via `fs.existsSync` / `fs.readFileSync`, then builds a self-contained prompt that includes the role preamble, current spec (if any), and new excerpts.

**`index.ts`**: Removed the `createSpecConversation` import and the `getBranch` import. Removed the `specConversationId` creation block (the `if (!branchRecord?.specConversationId)` guard and the inner `createSpecConversation` call). The `updateSpec` call now takes `(allNewMessages, sPath)`. `upsertBranch` call no longer includes `specConversationId`.

**`types.ts`**: Removed `specConversationId` from `BranchRecord`.

**`db.ts`**: Dropped `spec_conversation_id` from the `branches` CREATE TABLE, `upsertBranch` INSERT/UPDATE, and `getBranch` return mapping. `getBranch` is now unused but retained as a valid query helper.

### Note on existing DB

Existing `machinen.db` files still have the `spec_conversation_id` column in the `branches` table. SQLite's `CREATE TABLE IF NOT EXISTS` will not alter the existing table — the column will simply go unused. No migration needed.

### How "new excerpts" are determined

The stateless `updateSpec` only receives new messages — not the full conversation history. The mechanism is the `last_line_offset` cursor stored per conversation in the `conversations` table.

The flow in `index.ts` `runSpecUpdate`:

1. For each conversation associated with the branch, `readFromOffset(jsonlPath, conv.lastLineOffset)` reads only lines added since the last run.
2. The offset is advanced immediately after reading (`upsertConversation` with new `lastLineOffset`), so a crash mid-update will not re-send the same messages.
3. All new messages across all conversations for the branch are collected and passed to `updateSpec`.

`updateSpec` then combines these new excerpts with the current spec file on disk (if it exists) to produce an updated spec. The spec file carries the accumulated understanding; the offset cursor ensures we only feed the delta. These two mechanisms are orthogonal — offset tracking lives in `index.ts`/`db.ts`, spec composition lives in `spec.ts`.

---

## Added JSONL path logging to watcher and spec update (2026-03-03)

The daemon auto-detects conversations on startup (`ignoreInitial: false` in chokidar), but was not logging the file paths being processed. Added three log points in `index.ts`:

- `[watch] discovered: <path> (<repo> @ <branch>)` — when a conversation file is seen for the first time and indexed.
- `[watch] changed: <path> (<repo> @ <branch>)` — when a known conversation file is modified.
- `[spec] <path>: offset N → M | K new messages` — during `runSpecUpdate`, per conversation file being read (changed from logging `conversationId` to `jsonlPath`).

---

## Fixed `claude -p` hang and reduced log noise (2026-03-03)

### Hang fix

Running the daemon and observing `[claude] running | prompt: N chars` followed by no output — the `execa` call to `claude -p` hangs indefinitely, even without `--resume`.

**Root cause (conjecture)**: by default execa connects the child process's stdin to the parent. When spawned from within a Claude Code session, the parent's stdin may be occupied or in a state that causes the Claude CLI to block waiting for input, even in `-p` mode.

**Fix**: added `stdin: "ignore"` to the execa options in `runClaude`. This prevents the child from inheriting the parent's stdin entirely.

### Noise reduction

`runSpecUpdate` was logging every conversation it checked, including those with 0 new messages. On a repo with many conversations, this produced a wall of `offset N → N | 0 new messages` lines that obscured the actually relevant output. Changed to only log conversations with `messages.length > 0`.

### Verification

Confirmed: the `stdin: "ignore"` fix resolved the hang when spawning from within a Claude Code session. The daemon now completes `claude -p` calls and writes spec files successfully. The `--resume` + `-p` hang remains a separate, confirmed CLI-level issue (reproduced manually outside of any spawned context).

Note: the `stdin: "ignore"` fix is specifically for the spawned-from-Claude-Code context. The original `--resume` + `-p` hang is a genuine Claude CLI bug, not caused by stdin inheritance.

---

## Need for a spec reset mechanism (2026-03-03)

Due to previous bugs (empty claude output, `--resume` hang, stdin inheritance hang), the generated specs are sparse. The `lastLineOffset` cursor in the DB means the daemon considers old messages "already processed" and will not re-read them. We need a way to reset a branch's state so all conversations are re-read from the start and the spec is regenerated with full context.

### Design discussion

We considered two approaches:

**Option A — Single-shot concatenation**: Zero all offsets, delete the existing spec, collect all messages from all conversations, fire one `claude -p` call with everything. Simple, one call, full context. Risk of exceeding CLI arg limits for very large histories, but acceptable for early days.

**Option B — Sequential chunking**: Process conversations one at a time, building the spec incrementally across multiple Claude calls. More resilient to size limits, but more complex and more Claude calls.

We chose **Option A** — keep it simple, avoid overengineering. This is early days; if we hit size limits later we can revisit.

The mechanism will be a CLI flag: `tsx src/index.ts --reset <branch>`.

### RFC: Branch spec reset

#### 2000ft View

We add a `--reset <branch>` CLI mode to the daemon entry point. When invoked, it resets all conversation offsets for the given branch to 0, deletes the existing spec file (if any), re-reads all messages from all associated JSONL files, and regenerates the spec in a single `claude -p` call. The daemon does not start in this mode — it performs the reset and exits.

#### Behaviour Spec

```
GIVEN a branch has conversations indexed in the DB
AND the user runs `tsx src/index.ts --reset <branch>`
WHEN the reset executes
THEN all conversation lastLineOffset values for that branch are set to 0
AND the existing spec file for that branch is deleted (if it exists)
AND all messages from all conversations are read from offset 0
AND a single updateSpec call is made with all collected messages
AND the updated spec is written to disk
AND the process exits

GIVEN a branch has no conversations indexed
WHEN the user runs `tsx src/index.ts --reset <branch>`
THEN a message is logged indicating no conversations found
AND the process exits
```

#### Implementation Breakdown

```
[MODIFY] index.ts  — detect --reset <branch> arg, implement resetBranch() function,
                     skip daemon startup when in reset mode
[MODIFY] db.ts     — add resetConversationOffsets(repoPath, branch) helper to zero
                     all offsets for a branch
```

#### Invariants

- Reset mode is mutually exclusive with daemon mode — the process either resets and exits, or starts the watcher.
- After reset, the spec file is regenerated from scratch — the previous spec is not fed back as context.
- Conversation-to-branch mappings are preserved — only the offsets are zeroed.

#### Tasks

- [x] Add `resetConversationOffsets` to `db.ts`
- [x] Add `--reset <branch>` handling to `index.ts`
- [x] Verify typecheck passes

---

## Implemented branch spec reset (2026-03-03)

All tasks complete. `pnpm typecheck` passes cleanly.

### What changed

**`db.ts`**: Added `resetConversationOffsets(repoPath, branch)` — runs an UPDATE to zero `last_line_offset` for all conversations matching the repo+branch. Returns the count of rows affected. Note: `node:sqlite`'s `run()` returns `changes` as `number | bigint`, so we wrap with `Number()`.

**`index.ts`**: Added `resetBranch(branch)` async function and `--reset <branch>` arg detection at the module level. The flow:

1. Uses `process.cwd()` as `repoPath` (must be run from within the repo).
2. Looks up all conversations for the branch.
3. Deletes the existing spec file (so `updateSpec` uses the "new branch" code path — no previous spec fed back as context).
4. Zeros all offsets via `resetConversationOffsets`.
5. Re-reads all messages from all JSONL files from offset 0.
6. Fires a single `updateSpec` call with all collected messages.
7. Advances offsets so the daemon won't re-process on next startup.
8. Exits.

The daemon startup (`startWatcher`) is now gated inside an `else` — if `--reset` is present, we run the reset and exit without starting the watcher.

### Suggested verification

```bash
cd /Users/justin/rw/worktrees/machinen-experiments_specs
npx tsx specs/src/index.ts --reset specs
```

This should log the reset flow, invoke `claude -p` with the full conversation history, and write an updated spec to `~/.machinen/specs/`.

---

## Fixed E2BIG when resetting with large conversation history (2026-03-03)

Running `--reset specs` hit `E2BIG` — the concatenated prompt (~1.7MB) exceeded macOS's `ARG_MAX` limit (~256KB) when passed as a CLI positional arg to `claude -p <prompt>`.

**Fix**: switched `runClaude` from passing the prompt as a positional arg to piping it via execa's `input` option:

```ts
// Before (breaks on large prompts):
const result = await execa(CLAUDE_BIN, ["-p", prompt], { env, stdin: "ignore" });

// After (pipes via stdin, works at any size):
const result = await execa(CLAUDE_BIN, ["-p"], { env, input: prompt });
```

execa's `input` option creates a pipe, writes the string, then closes it. This is fundamentally different from stdin inheritance (the previous hang cause) — the explicit close ensures `claude -p` sees EOF and processes the input normally.

This fix applies to all `runClaude` calls, not just reset — incremental updates that happen to produce large prompts would have hit the same limit eventually.

---

## "Prompt is too long" — Option A single-shot fails (2026-03-03)

The stdin fix resolved `E2BIG` (the OS limit), but the Claude CLI itself now rejects the prompt: `stdout: 'Prompt is too long'`, exit code 1. The concatenated conversation history (~1.7MB of extracted text) exceeds the Claude CLI's own prompt length limit.

This confirms that **Option A (single-shot concatenation) is not viable** for branches with substantial conversation history. Switching to **Option B (sequential chunking)** — process conversations one at a time, building the spec incrementally across multiple Claude calls.

### RFC: Sequential reset (Option B)

#### 2000ft View

Instead of collecting all messages from all conversations and firing one giant `claude -p` call, `resetBranch` iterates through conversations sequentially. For each conversation, it calls `updateSpec` with that conversation's messages. Since `updateSpec` already reads the current spec from disk and includes it as context, the spec accumulates understanding across calls — the same pattern as normal incremental operation, just replayed from scratch.

#### Behaviour Spec

```
GIVEN a branch has N conversations indexed
AND the user runs --reset <branch>
WHEN the reset executes
THEN the existing spec file is deleted
AND conversation offsets are zeroed
AND for each conversation (sequentially):
  - all messages are read from offset 0
  - updateSpec is called with those messages
  - the spec file on disk is updated
  - the offset is advanced
AND the process exits with the fully rebuilt spec on disk
```

#### Implementation Breakdown

```
[MODIFY] index.ts / resetBranch()  — replace single updateSpec call with
                                     per-conversation loop calling updateSpec
```

No changes to `db.ts`, `spec.ts`, or `reader.ts` needed — the existing `updateSpec` already handles the "has existing spec" vs "no spec" branching.

#### Tasks

- [x] Rewrite `resetBranch` to call `updateSpec` per conversation
- [x] Verify typecheck passes
- [x] Update worklog with results

---

## Implemented sequential reset (Option B) (2026-03-03)

All tasks complete. `pnpm typecheck` passes cleanly.

### What changed

**`index.ts` / `resetBranch`**: Replaced the single `updateSpec(allMessages, sPath)` call with a per-conversation loop. Each iteration:

1. Reads all messages from one conversation via `readFromOffset(conv.jsonlPath, 0)`.
2. Calls `updateSpec(messages, sPath)` — which reads the current spec from disk (written by the previous iteration, if any) and produces an updated version.
3. Advances the offset for that conversation.

The first conversation creates the initial spec (no spec file exists yet, so `updateSpec` uses the "new branch" path). Each subsequent conversation refines it (spec file now exists, so `updateSpec` includes it as context). This is the same accumulation pattern as normal daemon operation — just replayed from scratch.

Logging now shows progress: `[reset] (1/3) <path>: N messages (M lines)`.

### Note

Individual conversations may still be large enough to hit "Prompt is too long" — but this is unlikely since a single conversation is bounded by the Claude Code session context window. If it does happen, we would need to chunk within a conversation as well, but that is a bridge to cross later.

---

## Single-conversation "Prompt is too long" — added excerpt chunking (2026-03-03)

The sequential per-conversation approach worked for conversations 1–3, but conversation 4 (54 messages, ~1.5MB of extracted text) hit the Claude CLI's "Prompt is too long" error. So we do need within-conversation chunking after all.

### What changed

**`spec.ts` / `updateSpec`**: Now chunks excerpt lines by size before processing. The flow:

1. Extract all excerpt lines from messages (same as before).
2. Split into chunks where each chunk's total char count stays under `MAX_EXCERPT_CHARS` (300K chars).
3. Process chunks sequentially — each chunk reads the current spec from disk (updated by the previous chunk), builds a prompt, calls Claude, and writes the result back.

For conversations that fit in a single chunk (the common case), behaviour is identical to before — just one Claude call. For large conversations, it transparently splits into multiple calls with the spec accumulating between them.

Logging shows chunk progress when chunking occurs: `[spec] chunk 1/5 | 12 messages | 298000 chars`.

The 300K limit is conservative — from the successful run data, conversation 3's prompt was ~75K total and worked, conversation 4 at ~1.5M failed. The Claude CLI's limit is likely tied to the model's context window (~200K tokens ≈ ~800K chars), but we leave generous headroom for the preamble, current spec content, and response tokens.

---

## Investigated what we actually send to the spec agent (2026-03-03)

Ran measurement scripts against conversation 4 (the one that hit "Prompt is too long" — 54 messages, ~1.5MB of excerpts). Findings:

### Content breakdown

| Source                        | Chars  | Notes                           |
| ----------------------------- | ------ | ------------------------------- |
| `user:string`                 | 1,543K | Overwhelmingly dominant         |
| `assistant:text`              | 17.6K  | Claude's actual prose responses |
| `assistant:redacted_thinking` | 1.2K   |                                 |
| `assistant:thinking`          | 0.9K   |                                 |

The assistant text blocks are tiny. Virtually all the data comes from user messages stored as plain strings.

### What's in the user strings

Inspecting individual user messages revealed that they contain far more than the human's typed input:

- **`<system-reminder>` tags**: IDE diagnostics, linter output, explanatory style reminders — repeated in every message
- **`<ide_opened_file>` tags**: file-open notifications
- **Tool results embedded as text**: file contents, command outputs piped back as part of the user turn
- **Nested spec update prompts**: this particular conversation (d485ea47) turned out to be the old stateful spec-maintenance conversation — its user messages contain the previous `updateSpec` prompts, which themselves contain excerpts, creating an exponential data growth pattern (messages grew from ~0.2K to ~89K each)

The human's actual typed input — the intent and decisions — is a small fraction of each user message.

### Conclusion

We need to strip system noise from user messages in `extractText`. The tags to remove:

- `<system-reminder>...</system-reminder>` — system context, linter output, style reminders
- `<ide_opened_file>...</ide_opened_file>` — file-open notifications
- `<ide_selection>...</ide_selection>` — IDE selection context (if present)

This is not specific to the reset case — normal incremental updates also send this noise. Stripping it improves both data size and spec quality (less irrelevant context for the spec agent to wade through).

Note: we considered filtering out the old spec-maintenance conversation specifically, but that only helps this one case. The noise stripping helps all conversations universally.

### RFC: Strip system noise from extracted text

#### 2000ft View

We modify `extractText` in `reader.ts` to strip known system-injected tags from user message content before returning the text. This reduces excerpt sizes dramatically and improves signal-to-noise ratio for the spec agent.

#### Implementation Breakdown

```
[MODIFY] reader.ts / extractText  — strip <system-reminder>, <ide_opened_file>,
                                    and <ide_selection> tag blocks from string content
```

#### Invariants

- Only tag blocks are stripped — the human's actual text between tags is preserved.
- Stripping applies to all content types (string and array), though in practice it mainly affects string-type user messages.
- The same stripping applies in both daemon and reset modes (it lives in the shared `extractText` function).

#### Tasks

- [x] Add tag stripping to `extractText` in `reader.ts`
- [x] Verify typecheck passes

---

## Implemented system tag stripping in extractText (2026-03-03)

All tasks complete. `pnpm typecheck` passes cleanly.

### What changed

**`reader.ts`**: Added `stripSystemTags` function and three regex patterns that match and remove `<system-reminder>`, `<ide_opened_file>`, and `<ide_selection>` tag blocks (including their contents). Uses `[\s\S]*?` for non-greedy multiline matching. Applied in both code paths — string content and array-of-blocks content.

---

## Rethinking spec output: behaviour-only in Gherkin format (2026-03-03)

### Motivation

Looking at the generated spec for the `specs` branch, it contains architectural narration (System Architecture, Key Components table, Invariants & Constraints, Key Decisions, Open Issues, Probe Scripts) alongside the actual behaviour spec. The original prompt in `spec.ts` asks for three things: a purpose summary, behaviour in GIVEN/WHEN/THEN, and key decisions/constraints.

The intended use case for these specs is **writing tests**. For that purpose, the architectural narration is noise — a test-writing agent (or a human reading acceptance criteria) needs behaviour, not a system architecture overview. The architectural context already lives in worklogs and blueprints; duplicating it in the spec adds bulk without adding test-relevant signal.

### Decision

We strip the spec output down to **behaviour only**, in Gherkin format. Specifically:

1. **Output format**: Pure Gherkin (`Feature`, `Scenario`, `Given`/`When`/`Then`/`And`) — not wrapped in Markdown code fences. The spec file itself _is_ the Gherkin, readable directly as structured acceptance criteria.
2. **No architectural sections**: No "System Architecture", no "Key Decisions", no "Invariants", no component tables. The spec agent's sole job is to extract and maintain testable behaviours.
3. **Gherkin outside code blocks**: The existing spec uses GIVEN/WHEN/THEN inside triple-backtick blocks. We want the Gherkin as top-level text — it is the document format, not an embedded code snippet.

This is a prompt-only change — we modify `SPEC_ROLE_PREAMBLE` in `spec.ts` to instruct the spec agent to output Gherkin and nothing else.

### RFC: Behaviour-only Gherkin spec output

#### 2000ft View

We modify the spec agent's prompt to produce pure Gherkin-format behaviour specifications instead of a mixed Markdown document with architecture, invariants, and decisions. The spec file becomes a `.feature`-style document: `Feature` blocks with `Scenario` entries using `Given`/`When`/`Then`/`And` steps. This makes the spec directly usable as input for test generation.

#### Implementation Breakdown

```
[MODIFY] specs/src/spec.ts  — rewrite SPEC_ROLE_PREAMBLE to instruct Gherkin-only output;
                               update the prompt templates to match
```

#### Behaviour Spec (for this change itself)

```
GIVEN the spec agent receives conversation excerpts
WHEN it generates or updates a spec
THEN the output is pure Gherkin format (Feature/Scenario/Given/When/Then)
AND no architectural narration, invariants, or decision logs are included
AND the Gherkin is not wrapped in code fences
```

#### Invariants

- The spec file on disk contains only Gherkin — no Markdown headings, no tables, no code blocks.
- The prompt explicitly forbids non-behavioural sections.
- The chunking and stateless update mechanics in `updateSpec` are unchanged.

#### Tasks

- [x] Rewrite `SPEC_ROLE_PREAMBLE` in `spec.ts` to instruct Gherkin-only output
- [x] Update prompt templates (both new-branch and existing-branch paths) to match
- [x] Run a `--reset` to regenerate the `specs` branch spec and verify the output
- [x] Verify typecheck passes

---

## Spec output still leaks internals despite Gherkin prompt (2026-03-03)

We ran `--reset specs` with the new Gherkin-only prompt and `extendEnv: false` fix. The reset completed successfully across all 20 conversations with chunking working as expected. However, reviewing the generated spec reveals that roughly half the scenarios describe implementation internals rather than user-observable product behaviour.

### Evidence: scenarios that leak internals

**Entirely internal (should not be in the spec):**

| Scenario                                                                   | What it describes                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| "Message content is a plain string"                                        | Internal content block parsing                                    |
| "Message content has an unrecognised shape"                                | Internal content block parsing                                    |
| "Init request must not ask for an empty skeleton"                          | Internal prompt engineering decision                              |
| "Init request that asks for an empty skeleton produces no useful content"  | Documenting a past prompt bug                                     |
| "Spec-maintenance conversation is never recreated"                         | Internal session management                                       |
| "Resuming the spec conversation with a large payload returns empty output" | Internal CLI bug                                                  |
| Entire "Environment isolation" feature                                     | CLAUDECODE env var handling                                       |
| Entire "CLI prompt delivery" feature                                       | stdin vs positional arg, session creation/resume                  |
| Entire "Operational logging" feature                                       | Internal debug logging                                            |
| "Conversation content is read on demand"                                   | Internal storage decisions ("does not store in its own database") |

**Actually user-observable (good as-is):**

- "New conversation activity is detected"
- "First spec is created for a branch"
- "Spec is updated with new conversation excerpts"
- "Spec files are stored at a deterministic path" (borderline — leaks "derived from repo and branch name")

### Root cause analysis

The prompt already says "Do NOT reference internal function names, variable names, CLI flags, database tables, storage mechanisms, implementation patterns, or code structure." But the spec agent is still extracting internal behaviour because:

1. **The conversation excerpts themselves are full of implementation detail.** The development conversations discuss stdin piping, env vars, session IDs, prompt engineering — the spec agent faithfully captures these as "behaviours" because they _were_ the subject of the conversation. The prompt says "extract the intent, behaviour, and requirements described or implied" — and the conversations describe internal implementation behaviour.

2. **No clear definition of "user".** The prompt says "what the system does from the outside, as a user or external system would observe it" — but doesn't define who the user is. The spec agent may interpret "user" as "the developer running the daemon" rather than "an end user of the product being developed on the branch."

3. **The conversations contain debugging sessions.** Probe scripts, env var workarounds, CLI flag testing — these are exploratory investigations, not product requirements. The spec agent has no way to distinguish "we investigated this" from "the system should do this."

### Options for higher-confidence product-level specs

**Option A — Stronger negative examples in the prompt.** Add explicit examples of what NOT to include: "Do not describe how the system spawns subprocesses, manages environment variables, parses message formats, handles internal errors, or logs diagnostic information. These are implementation concerns, not product behaviours." This is the lowest-effort option but relies on the LLM generalising from negative examples.

**Option B — Define the user persona in the prompt.** Add: "The user is an engineer who runs the daemon and expects it to maintain spec files that reflect their feature branch work. They interact with the system by: (a) working on a branch using Claude Code, (b) starting the daemon, (c) optionally running --reset. They observe: spec files appearing/updating on disk." This anchors the spec agent to a specific perspective.

**Option C — Pre-filter conversations before sending to the spec agent.** Strip out messages that are clearly debugging/investigation (probe scripts, env var experiments) rather than feature development. This is harder — we would need heuristics to distinguish the two.

**Option D — Combine A and B.** Define the user persona AND provide strong negative examples. This gives the spec agent both the positive framing ("describe what this person observes") and the negative guardrails ("don't describe these internal concerns").

### Recommendation

**Option D (A + B combined)** has the highest confidence. The user persona gives the agent a consistent perspective to write from, and the negative examples catch the common failure modes we observed. Neither alone is sufficient — the persona alone still leaves room for "the developer-user observes that env vars are stripped", and the negative examples alone leave the agent guessing about who it's writing for.

---

## Refined spec perspective: reader persona + black box test (2026-03-03)

### Decision

We chose a variant of Option D that replaces the negative-example list with a more durable mechanism: the **black box test**. The two components:

1. **Reader persona**: "You are writing for a QA engineer who has never seen the source code. They can only interact with the product through its external interfaces." This anchors perspective — the agent writes for someone who can only observe external behaviour. Critically, this is product-agnostic. We don't need to describe Machinen's interfaces; the agent infers them from the conversations.

2. **Black box test**: "Could this scenario be verified by someone who can only use the product's external interfaces, without reading source code or inspecting internal state? If not, do not include it." This gives the agent a concrete, repeatable filter to apply per scenario.

The old rule 7 was a long negative-example list ("do NOT reference internal function names, variable names, CLI flags, database tables..."). This had two problems: (a) the agent pattern-matches against the list rather than reasoning about what's external, and (b) it incorrectly excludes CLI flags, which _are_ external interfaces for CLI products. The black box test self-adjusts — `--reset <branch>` passes because a user runs it; `--session-id` fails because no user sees it.

We also replaced the old rule 7 with a simpler instruction to ignore debugging/investigation conversations entirely, since those are never product behaviours.

### RFC: Spec perspective refinement

#### 2000ft View

We rewrite `SPEC_ROLE_PREAMBLE` in `spec.ts` to anchor the spec agent's perspective using a reader persona and black box test, replacing the previous negative-example-based approach. This is a prompt-only change — no code logic changes.

#### Implementation Breakdown

```
[MODIFY] specs/src/spec.ts  — rewrite SPEC_ROLE_PREAMBLE
```

#### Tasks

- [x] Rewrite `SPEC_ROLE_PREAMBLE` in `spec.ts`
- [x] Verify typecheck passes

---

## Spec output still includes commentary and style artifacts (2026-03-03)

After running `--reset` with the revised preamble, the generated spec still contains non-Gherkin output: a "★ Insight" block (from the explanatory output style inherited by the spawned `claude -p` process) and a narration paragraph ("Now I have full context..."). The preamble rules say "output ONLY Gherkin" and "Do NOT output commentary", but the inherited system prompt's style instructions override our user-prompt-level rules.

### Hypothesis

The `claude -p` invocation inherits the session's default system prompt, which includes output style instructions (explanatory mode with `★ Insight` blocks). Our `SPEC_ROLE_PREAMBLE` is in the user message, which the system prompt instructions may take precedence over. Using `--system-prompt` to pass the preamble would replace the default system prompt entirely, stripping the inherited style.

### Approach (experimental)

Move `SPEC_ROLE_PREAMBLE` from the user message to `--system-prompt`. The user message then contains only the spec content and excerpts. This separates role instructions from content and, critically, replaces the default system prompt that causes the style leakage.

Not confident this is the root cause — trying it as a quick experiment.

### RFC: Move preamble to --system-prompt

#### 2000ft View

We split the `runClaude` interface to accept an optional system prompt alongside the user prompt. `updateSpec` passes `SPEC_ROLE_PREAMBLE` via `--system-prompt` and keeps only the spec/excerpt content in the user message. This replaces the inherited default system prompt.

#### Implementation Breakdown

```
[MODIFY] specs/src/spec.ts  — runClaude takes systemPrompt param, passes via --system-prompt flag;
                               updateSpec passes SPEC_ROLE_PREAMBLE as system prompt,
                               spec+excerpts as user prompt
```

#### Tasks

- [x] Update `runClaude` to accept and pass `--system-prompt`
- [x] Update `updateSpec` to split preamble from content
- [x] Verify typecheck passes

### Result

The `--system-prompt` change fixed the `★ Insight` style leakage — the spawned agent no longer inherits the explanatory output mode. However, the spec output still contains implementation details: scenarios reference CLI flags (`--system-prompt`, `--session-id`, `--print`), internal mechanisms (session ID storage, subprocess invocation), and tooling concerns.

The black box test in the preamble is not biting hard enough. The root issue: the conversations themselves discuss implementation mechanics as their subject matter. The agent reads "we need to pass `--session-id` to the claude CLI" and faithfully captures it as a behaviour, because both product intent and implementation detail are stated with equal conviction in the conversation text.

---

## Concrete examples + second-pass filter for spec quality (2026-03-03)

### Analysis

We considered three approaches to improve the agent's filtering:

1. **Sharpen the black box test with concrete pass/fail examples in the preamble.** Add 2-3 explicit examples: "PASS: 'a spec file is created' — a user can check the filesystem. FAIL: 'the claude CLI is invoked with --print' — a user cannot observe how subprocess calls are made." This teaches the agent the distinction by demonstration rather than abstract instruction.

2. **Add a second-pass filter.** After the agent produces Gherkin, run a second `claude -p` call that reviews each scenario against the black box test and strips the ones that fail. This separates generation from filtering — the first pass extracts everything, the second pass prunes. More expensive (doubles Claude calls) but gives a dedicated review step.

3. **Reframe the input labels.** Instead of `[user]`/`[assistant]`, present excerpts more abstractly. Rejected — the labels help the agent understand conversational context, and the problem isn't the labels, it's the content.

### Decision

We go with both **1 and 2**: concrete examples in the preamble (cheap, improves first-pass quality) plus a second-pass filter (catches what leaks through). The examples make the first pass better, and the filter provides a safety net.

### RFC: Concrete examples + second-pass filter

#### 2000ft View

Two changes to improve spec quality. First, we add concrete pass/fail examples to `SPEC_ROLE_PREAMBLE` so the agent learns the black box distinction by demonstration. Second, we add a `filterSpec` function that takes the generated Gherkin, sends it to a second `claude -p` call with a system prompt focused on reviewing each scenario against the black box test, and returns the filtered result. `updateSpec` calls `filterSpec` after each chunk's generation step.

#### Implementation Breakdown

```
[MODIFY] specs/src/spec.ts  — add pass/fail examples to SPEC_ROLE_PREAMBLE;
                               add FILTER_SYSTEM_PROMPT constant;
                               add filterSpec() function;
                               call filterSpec() after each chunk in updateSpec
```

#### Tasks

- [x] Add concrete pass/fail examples to `SPEC_ROLE_PREAMBLE`
- [x] Add `filterSpec` function with its own system prompt
- [x] Call `filterSpec` after each chunk write in `updateSpec`
- [x] Verify typecheck passes

### Result

Ran `--reset specs` with the new two-pass approach. The output is dramatically improved — all implementation-detail scenarios are gone. No more CLI flags, SQLite columns, env var stripping, or session ID management in the spec. Every remaining scenario describes externally observable behaviour: file creation/updates on disk, daemon operation, incremental spec updates.

The combination of three mechanisms solved the problem:

1. **Reader persona** ("QA engineer who has never seen the source code") — anchors perspective.
2. **Concrete pass/fail examples** in the preamble — teaches by demonstration, not abstract instruction.
3. **Second-pass filter** — dedicated review step that catches what leaks through the first pass.

The `--system-prompt` flag also helped by stripping inherited style instructions (explanatory output mode) that were causing `★ Insight` blocks in the output.
