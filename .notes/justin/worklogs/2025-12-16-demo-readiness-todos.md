# Demo Readiness Todos (Next Few Days)

## Context
We’ve got a demo coming up soon, and the core pipeline (ingest → index → smart-link → query) is now working well enough to produce a coherent narrative timeline on production.

The goal for the next few days is **polish + reliability**:
- Make the MCP UX smoother (Cursor tools show up quickly + reliably).
- Remove a couple sharp edges in ingestion/indexing so we can confidently populate and query demo data.
- Create an isolated demo namespace on prod so we can iterate without contaminating “real” prod narratives.

## Current baseline (working)
- **Cross-source smart linking is working** (issue ↔ PR ↔ discord ↔ cursor), and `/query` can retrieve a coherent timeline from any entry point.
- We can **populate demo data via `/admin/resync` inline** for specific `r2Key`s (reliable and deterministic).

## Todos

### 1) Fix Cursor MCP server to show up more readily
- **Why**: Demo flow relies on “open Cursor → tools are there → query immediately”.
- **What**:
  - Make it require less “nudging” to get Cursor to actually use it.
  - Add an explicit “I’m talking to you / use Machinen MCP now” directive pattern (prompting / instruction text) so Cursor reliably routes queries to Machinen when appropriate.
  - Fix current breakage: MCP tool calls are erroring (likely an args/schema mismatch like `"query" not expected` or `"query" required but missing`).
- **Done when**:
  - From a clean start, Cursor shows the MCP server + tools consistently within a few seconds.
  - When the user clearly wants Machinen, Cursor consistently calls the MCP tool without manual coaxing.
  - MCP calls no longer error due to argument shape / schema mismatch.

### 2) Allow Cursor scripts to use an env var for Moment Graph namespace
- **Why**: We want to point the MCP tooling at the demo namespace without code changes (and without accidentally querying prod-default).
- **What**:
  - Read `MOMENT_GRAPH_NAMESPACE` from your shell environment (e.g. set in `~/.zshrc`) and have Cursor/MCP forward it when querying so demo data can be isolated.
- **Done when**:
  - Setting `MOMENT_GRAPH_NAMESPACE` is enough to route MCP queries to the chosen namespace.
  - If `MOMENT_GRAPH_NAMESPACE` is unset, behavior remains sane (uses production defaults).

### 3) Fix Discord `idFromName` issue
- **Edit**: No fix needed - this was temporary, result of bad deploy, fixed already

### 4) “0 macros also fine”
- **Why**: We’re currently producing low-signal macro moments for Cursor convos that have no technical content (e.g. “thanks”), which pollutes the demo narrative.
- **What**:
  - Treat “0 macro moments synthesized” as a valid outcome (especially for Cursor):
    - Skip smart-linking, moment creation, and vector upserts for that doc.
    - Still update indexing state so the system doesn’t retry forever.
    - Log a clear message so it’s debuggable (“no macros produced; skipping moment graph write”).
- **Done when**:
  - Indexing a doc that yields 0 macros returns success and does not throw.
  - Subsequent resyncs behave idempotently.
  - Cursor convos that are only acknowledgements do not generate “useless” macro moments.

### 5) Populate demo data in an isolated demo namespace on production
- **Why**: Demo needs stable, curated data and linking behavior without polluting existing prod narratives.
- **What**:
  - Create a new namespace for demo data (details TBD) and index only demo artifacts into it.
  - Provide a small “demo seed list” of `r2Key`s (GitHub issue/PR + relevant Discord thread + key Cursor convos).
  - Verify the narrative query outputs the expected timeline in one shot.
- **Done when**:
  - One command (or a short, documented sequence) populates demo data.
  - `/query` produces the narrative timeline reliably and quickly from multiple phrasings.

### 6) Reindex all data in r2
- Check idempotence


## Known sharp edge (worth fixing if time permits)
- **Queue sendBatch limit (100)**: We saw a failure when trying to enqueue >100 chunk messages for a large Cursor conversation.
  - This doesn’t block demo if we use `mode:"inline"` resync, but it’s a reliability hole.
  - Fix is to batch queue sends in groups of 100 (or fewer), and/or adjust the scheduler strategy.


## Work notes (Cursor MCP nudging + directive patterns)

### Hypothesis: what Cursor is optimizing for
- Cursor seems to decide whether to call an MCP tool based on tool name + description match to the user’s phrasing, plus whether the tool looks like the shortest path to produce the requested output.
- When a tool is described as “project context search”, Cursor may still skip it if the user prompt reads like a standard chat question. A more explicit routing cue in the prompt usually improves tool selection.

### Prompt patterns to reduce nudging (explicit routing cues)
- **Prefix trigger**: Use a stable prefix that means “call Machinen MCP”.
  - Example forms:
    - `mchn: <question>`
    - `machinen: <question>`
    - `use machinen mcp: <question>`
  - Expected behavior: agent calls the MCP tool first, then answers from the returned context.
- **Two-step directive**: Put the call instruction in the first sentence and the question in the second.
  - Example: “Use Machinen MCP to answer this. Where is the query pipeline implemented?”
- **Scope anchor**: Include “in this repo” / “in Machinen” / “in our codebase” in the question.
  - Example: “In this repo, how does narrative query choose between Moment Graph and Evidence Locker?”

### If prompt shaping still does not trigger a tool call
- **Explicit tool invocation template**: Tell the agent to call the tool by name and provide the argument shape.
  - Example:
    - “Call the MCP tool `search_machinen` now with arguments `{"query":"<question>"}`. Return only the tool output.”
- **Two-turn pattern**: First turn forces the tool call, second turn asks for synthesis.
  - Turn 1:
    - “Call the MCP tool `search_machinen` with `{"query":"<question>"}`. Do not answer yet.”
  - Turn 2:
    - “Now answer using only the tool output above.”

### Tool metadata ideas (to improve selection without user coaching)
- **Tool name**: Names that begin with `machinen_` (or similar) are easier to spot and less likely to collide with other tools.
- **Description**: Put the routing rule at the start, keep it short, include 2-3 example prompts that match the prefix trigger patterns above.
- **Shape**: Keep a single required string argument, but ensure the argument name is consistent everywhere (schema + handler) so call attempts don’t fail and retrigger user nudging.

### Attempt: tighten tool description for routing
- Updated the `search_machinen` tool description to read like usage rules (when to call, what phrases imply a call, and a few example prompts).
- Expanded it to include timeline questions (how we got to a solution, where work started, underlying issue, decision rationale).

## PR draft (work so far)

### Title
- Cursor MCP: make tool usage rules explicit

### Description
#### Problem
- Cursor does not consistently call the Machinen MCP tool for repo and timeline questions without repeated prompting.

#### Change
- Updated the MCP tool description to use directive wording and a short list of when to call the tool, including timeline and decision-history questions.
- Added a documented directive pattern (`mchn:` / explicit tool invocation) for forcing a tool call during the demo flow.

#### Testing
- Manual: prompted with `mchn:` and observed the agent choosing the Machinen tool more consistently.

#### Still to validate
- Tool call reliability from a clean Cursor start.
- The tool-call argument/schema mismatch mentioned in todo 1.

## Attempt: forward Moment Graph namespace from Cursor MCP
- Added support for `MOMENT_GRAPH_NAMESPACE` in the Cursor MCP script and forwarded it to `/query` as `momentGraphNamespace` when set.
- Kept the default behavior when the env var is unset.

