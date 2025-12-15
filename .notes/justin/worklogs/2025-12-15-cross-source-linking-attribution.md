## Work Log: Cross-Source Linking and Moment Attribution

**Date:** 2025-12-15

### Problem and scope

We have working Smart Linker behavior for cross-document attachment and a dev resync loop for controlled indexing runs. The next step is to start testing cross-data-source linking (Discord <-> GitHub <-> Cursor) and to keep enough source identity and reference details so query outputs can point back to the originating sources.

This log is focused on:

- Validating whether cross-source linking works with the current chunking + micro/macro moment pipeline.
- Deciding what source metadata should be recorded for moments (source type, document type, canonical reference identifiers).
- Deciding how to thread references (links or linkable ids) through the system without depending on the LLM to preserve URLs.

Out of scope for this pass:

- Implementing the changes. This is a brainstorming and architecture update step only.
- Perfect citation formatting or UI. The goal is a small set of primitives that can be extended.

### Context

Relevant prior work logs:

- `2025-12-12-iteration-1-smart-linker-cursor-cross-document.md` (Smart Linker, namespaces, moment trails, chunking hook consolidation)
- `2025-12-14-dev-manual-resync-loop.md` (manual resync endpoint and local log capture)

### Constraints

- Prefer minimal changes that can ship quickly.
- Avoid relying on the LLM to carry exact URLs end-to-end.
- Preserve enough stable identifiers so post-processing can add links later.

### Plan

- Reconfirm current pipeline shape:
  - how chunking is unified across sources
  - where micro-moment summarization happens and which plugin owns it
  - what provenance is stored on moments today
- Brainstorm attribution approaches, with a bias toward:
  - storing canonical source identifiers on moments (not just free text)
  - optionally enriching query output after the LLM step (or via lightweight placeholders)
- Draft proposed architecture doc updates and a refactor task list, then stop for approval before any code changes.

### Notes (start)

- The immediate validation target is a cross-source fixture that should link:
  - a Discord thread discussing a RedwoodSDK change
  - the corresponding GitHub issue and/or pull request
- Local data sync uses `rclone` into a local `.tmp/machinen` directory. For cross-source testing, we need to list the specific R2 keys to fetch for:
  - Discord thread objects covering the discussion window
  - GitHub issue `redwoodjs/sdk#552` and related PR(s)

### 2025-12-15 - Current pipeline notes (chunks, micro-moments, macro-moments)

Engine plugin ordering (indexing and querying):

- Smart Linker
- GitHub
- Discord
- Cursor
- Default

Chunking:

- The engine iterates plugins and selects the first chunking result with a non-zero length.
- Each source plugin returns chunks only for its own source.
- The chunk stream is the shared input for:
  - Evidence Locker indexing (Vectorize per chunk)
  - Micro-moment batching and caching (Moment Graph)

Micro-moment batching:

- The engine batches chunks (size and character caps), then computes micro-moment summaries in an engine-owned function.
- Plugins provide micro summarization prompt context via `getMicroMomentBatchPromptContext` (first-match by plugin order).
- Micro-moments are stored with:
  - a stable path derived from the batch hash + summary index
  - `sourceMetadata` containing the batch hash and the list of chunk ids in the batch

Macro-moments:

- Macro-moments are synthesized from the stored micro-moments.
- Macro-moments store micro-moment membership (`microPaths` and a hash) for idempotent updates.
- Macro-moments also have an optional `sourceMetadata` field, but they do not currently store the document's `source`, `type`, or `url` as first-class fields.

Immediate implication for attribution:

- We already have stable provenance hooks:
  - macro moment -> micro paths -> micro moments -> chunk ids
- This seems sufficient to derive per-moment source references at query time without depending on the LLM to preserve URLs.

### 2025-12-15 - Brainstorm: minimal attribution and links (bang for buck)

What I think we should optimize for in the first pass:

- Cross-source linking should work even when a document starts with low-signal text.
- Attribution should not depend on the LLM preserving exact URLs.
- References should be deterministic from stored ids so they can be formatted after the LLM step.

Candidate approach (small surface area):

- Keep the narrative text (moment title/summary) focused on what happened.
- Keep stable source references in structured form and derive URLs from those references when formatting the response.

Where to get source references:

- Document-level identity:
  - Moment already stores `documentId` (the R2 key), which encodes the source and often the entity identity (GitHub owner/repo/number, Discord guild/channel/thread id, Cursor conversation id).
- Fine-grained anchors:
  - Macro moments store micro paths.
  - Micro moments store the list of chunk ids for the batch.
  - Chunk ids already include stable identifiers like:
    - GitHub comment ids and issue/pr numbers
    - Discord message ids and thread ids

How to keep URLs out of the LLM path:

- Build a small set of "reference tokens" per moment at query time (example: `github:redwoodjs/sdk#552`, `discord:thread/<threadID>`, `cursor:conversation/<id>`).
- Include only those tokens (not full URLs) in the LLM context.
- After the LLM response, replace tokens or append a reference list that maps tokens to URLs computed deterministically.

Notes on what the system already supports:

- The plugin API has `formatFinalResponse` (waterfall) which is a natural place to do response-time enrichment and link insertion.
- The Evidence Locker already reconstructs source documents into context blocks that include URLs. For Moment Graph narrative answers, we can apply a similar idea but driven by moment provenance rather than chunk search results.

Open questions to resolve before coding:

- Whether to store a small `canonicalRef` string directly on moments (for faster query-time formatting), or compute it on demand from `documentId` and micro provenance.
- Whether cross-source linking needs stronger normalization in micro summaries (example: consistently output `owner/repo#number` when a GitHub URL appears in a Discord message).

### 2025-12-15 - Decision sketch: include source label + bracket ref in macro moment text

Goal:

- Each macro moment should read like "In a Discord thread ..." or "In a GitHub PR comment ..." and include a short bracketed reference token that can later be expanded into a URL.

Constraints:

- Do not rely on the LLM to emit or preserve the reference token.
- Keep the reference token short so it does not dominate embeddings.

Proposed middle-ground behavior:

- Derive a canonical ref token deterministically from document metadata:
  - GitHub: `mchn://gh/issue/<owner>/<repo>/<number>` and `mchn://gh/pr/<owner>/<repo>/<number>`
  - Discord: `mchn://dc/thread/<guildid>/<channelid>/<threadid>` (and optionally a message token later)
  - Cursor: either no ref token, or a generic label without an id
- Inject a source label + bracket token into the stored macro moment text deterministically, not via synthesis:
  - Prefix the moment title or summary with something like:
    - `Discord thread [mchn://dc/thread/<guildid>/<channelid>/<threadid>] - <title>`
    - `GitHub issue [mchn://gh/issue/<owner>/<repo>/<number>] - <title>`
  - This keeps query-time output consistent without requiring special prompt instructions.

Open question:

- Whether to inject the label+token at indexing time (stored on the moment) or at query time (formatted into the LLM context and/or appended after).

### 2025-12-15 - Plan: canonical reference format (mchn://<source>/<type>/<path>)

Decision:

- Use a readable canonical reference token format that is consistent across sources.
- Inject the label + canonical reference into macro moments at storage time (deterministic, not LLM-generated).

Format:

- `mchn://<source>/<type>/<path>`

Notes:

- Use short source codes for readability and consistency:
  - GitHub: `gh`
  - Discord: `dc`
- Keep the path format stable and parseable. Avoid punctuation variants like `#` or `!` to reduce ambiguity.

GitHub token formats:

- issue:
  - `mchn://gh/issue/<owner>/<repo>/<number>`
  - example: `mchn://gh/issue/redwoodjs/sdk/552`
- pull request:
  - `mchn://gh/pr/<owner>/<repo>/<number>`
  - example: `mchn://gh/pr/redwoodjs/sdk/530`
- issue comment:
  - `mchn://gh/issue_comment/<owner>/<repo>/<number>/<commentid>`
  - example: `mchn://gh/issue_comment/redwoodjs/sdk/552/1234567890`
- pull request comment:
  - `mchn://gh/pr_comment/<owner>/<repo>/<number>/<commentid>`
  - example: `mchn://gh/pr_comment/redwoodjs/sdk/530/1234567890`

Discord token formats:

- thread:
  - `mchn://dc/thread/<guildid>/<channelid>/<threadid>`
- thread message:
  - `mchn://dc/thread_message/<guildid>/<channelid>/<threadid>/<messageid>`
- channel day file (if needed later for backfills):
  - `mchn://dc/channel_day/<guildid>/<channelid>/<yyyy-mm-dd>`
- channel message:
  - `mchn://dc/channel_message/<guildid>/<channelid>/<yyyy-mm-dd>/<messageid>`

Cursor token formats (tentative):

- For now, include the source label but omit a canonical reference token for Cursor.
- If we later add one, keep it consistent with the above shape:
  - `mchn://cu/conversation/<conversationid>`

### 2025-12-15 - Plan: plugin-provided synthesis context vs deterministic ref injection

Decision direction:

- Put source/type details in the macro moment text so it reads naturally.
- Prefer passing canonical reference tokens into macro synthesis so the LLM includes them in the title/summary.

Proposed split:

- The engine builds the macro synthesis prompt in multiple sections.
- One of those sections is produced by a per-source plugin hook that returns explicit formatting instructions and reference context text.
- The engine concatenates that hook output into the prompt verbatim.

Rationale:

- Prompt context helps the model write summaries that mention the correct source type ("Discord thread", "GitHub issue comment").
- For now, it is acceptable if the token formatting deviates slightly, as long as the summary includes a readable source/type indicator and a recognizable canonical token.

Hook sketch (names to be decided later):

- A first-match hook used during macro synthesis prompt construction:
  - Inputs: document + indexing context
  - Output: a plain-text block with two parts:
    - (1) formatting rules for how the LLM should label sources and render canonical refs in titles/summaries
    - (2) concrete reference context for the current document (canonical refs and relevant entity details)

Prompt assembly plan (macro synthesis time):

- Section A: base instructions (engine-owned)
  - Describe what macro moments are.
  - Describe required output shape (titles, summaries, micro membership indices).
- Section B: formatting rules (engine-owned, generic)
  - Title formatting:
    - Prepend a short bracket label like `[GitHub Pull Request]` or `[Discord Thread]`.
  - Summary formatting:
    - When describing an action that happened in the source, include the canonical token in brackets near the first mention.
    - Prefer one canonical token per macro moment summary unless needed for clarity.
  - Canonical token format:
    - Use `mchn://<source>/<type>/<path>` as described earlier in this log.
- Section C: plugin-provided source formatting + reference context (hook output, concatenated verbatim)
  - This is where each source plugin can say:
    - “For titles, use this specific bracket label”
    - “When referencing this entity type, use this canonical token shape”
    - “Here are the concrete tokens for this document and its key entities”

Example hook output (GitHub PR):

- Formatting:
  - `title_label: [GitHub Pull Request]`
  - `when_referencing_pr_use: mchn://gh/pr/<owner>/<repo>/<number>`
  - `when_referencing_pr_comment_use: mchn://gh/pr_comment/<owner>/<repo>/<number>/<commentid>`
- Reference context:
  - `document_ref: mchn://gh/pr/redwoodjs/sdk/530`
  - `known_comment_refs:` (optional)
    - `mchn://gh/pr_comment/redwoodjs/sdk/530/1234567890`
  - `entity_hints:` (optional, natural language)
    - `This PR is in redwoodjs/sdk and is number 530.`

Example hook output (Discord thread):

- Formatting:
  - `title_label: [Discord Thread]`
  - `when_referencing_thread_use: mchn://dc/thread/<guildid>/<channelid>/<threadid>`
  - `when_referencing_thread_message_use: mchn://dc/thread_message/<guildid>/<channelid>/<threadid>/<messageid>`
- Reference context:
  - `document_ref: mchn://dc/thread/<guildid>/<channelid>/<threadid>`
  - `known_message_refs:` (optional)
    - `mchn://dc/thread_message/<guildid>/<channelid>/<threadid>/<messageid>`
  - `entity_hints:` (optional)
    - `This is a Discord thread with the ids above.`

Formatting decision (macro synthesis time):

- We rely on prompt instructions + plugin-provided formatting guidance to get source labels and canonical tokens into the title/summary text.

Cursor note:

- Cursor can still use a title label like `[Cursor Conversation]`.
- For now, the summary should omit a canonical token for Cursor (or include a generic token without an id).

### 2025-12-15 - Implementation kickoff

Next step is implementation. Per repo process, I updated architecture docs first to reflect the planned canonical token format and the macro synthesis prompt hook that provides source-specific formatting and reference context.

Docs updated:

- `docs/architecture/knowledge-synthesis-engine.md`
- `docs/architecture/plugin-system.md`
- `docs/architecture/system-flow.md`

### 2025-12-15 - Implementation status: Macro Synthesis & Attribution

Changes made:

- **Plugin Hook for Macro Context**: Added `subjects.getMacroSynthesisPromptContext` hook to the plugin API.
  - Wired the engine to call this hook before macro synthesis.
  - The hook allows each plugin to provide:
    - Title label (e.g., `[GitHub Issue #552]`)
    - Summary descriptor (e.g., `In a GitHub Issue (#552),`)
    - Canonical document reference token (e.g., `mchn://gh/issue/redwoodjs/sdk/552`)
    - Narrative context guidance (e.g., "treat as proposal")
- **Prompt Engineering**:
  - Updated the macro synthesis prompt to include generic formatting rules for canonical tokens.
  - Appended the plugin-provided context block verbatim to the prompt.
- **Tightened Output Requirements**:
  - To prevent the LLM from hallucinating or omitting prefixes, the prompt now explicitly requires the title and summary to start with the provided `title_label` and `summary_descriptor`.
  - The output schema in the prompt was changed to:
    - `TITLE: <required_title_prefix> <rest>`
    - `SUMMARY: <required_summary_prefix> ...`
  - A "Resolved requirements" block is injected into the prompt, explicitly listing the exact strings the model must use.
  - Set LLM temperature to `0` for maximum compliance.

### 2025-12-15 - Implementation status: Micro Summarization

Problem:
- Micro-moment summaries for GitHub issues were often phrased as "Implemented X" or "Added Y", even when the issue body only described a proposal or a bug report.
- The default summarizer didn't know the document context.

Changes made:
- **Engine-Owned Summarization**:
  - Moved the micro-moment summarization logic (LLM call + line-based parsing) into a dedicated engine function (`src/app/engine/subjects/computeMicroMomentsForChunkBatch.ts`).
  - Removed duplicated/flimsy regex parsing from plugins.
- **Plugin Hook for Micro Context**:
  - Added `subjects.getMicroMomentBatchPromptContext` hook.
  - This allows each plugin to provide a specific "lens" for the summarizer (e.g., "These chunks are from a GitHub issue; treat them as proposals/discussion unless explicitly completed").
- **Implementation**:
  - Implemented the hook in `github.ts` (issue vs PR), `discord.ts` (thread vs channel), `cursor.ts`, and `default.ts`.
  - The default plugin no longer branches on source; it just provides generic fallback context.

Status:
- Validated with manual reindexing of issue #552.
- Micro summaries now correctly use verbs like "Proposed", "Identified", "discussed".
- Macro summaries now correctly reflect the proposal nature of the issue.

### 2025-12-15 - Implementation status: Attribution (actors)

Observed:

- Batch-level "participants" lists biased attribution in micro summaries.
- Chunk metadata already includes an author per chunk, but GitHub authors were not consistently formatted as `@handle` (example: `Peterp` instead of `@peterp`).

Change:

- Micro summarization input now includes per-chunk actor labels directly in the chunk header (`author=...`).
- Plugins normalize chunk authors to the source's conventions:
  - GitHub: `@<login>` (lowercased, `@` prefixed).
  - Discord: `@<username>` when a username is present.
  - Cursor: split generation chunks into separate User and Assistant chunks so actor attribution is meaningful.

### 2025-12-15 - Test inputs (resync)

- Namespace (example): `cross-source-link-552-1`
- GitHub R2 key:
  - `github/redwoodjs/sdk/issues/552/latest.json`
- Discord thread local file:
  - `/Users/justin/rw/machinen/.tmp/machinen/discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json`
- Discord R2 key:
  - `discord/679514959968993311/1435702216315899948/threads/1373759907605516408/latest.json`

### 2025-12-15 - Query validation (namespace + response attribution)

Observed:

- Ran a query via `scripts/query.sh` against the local dev server: "What did we say about making RSC navigation use GET so fetches can be cached?"
- The response only referenced the GitHub issue discussion ("#552") and did not mention the Discord thread content that includes the same idea.

What the logs show:

- The query request hit `/rag/query` and then executed the chunk-based Evidence Locker path:
  - `optimizeContext` ran and selected 35 contexts (about 15k tokens), and the LLM prompt preview shows raw document context (example: "Issue #552 ... URL: https://...").
  - The response was produced by `callLLM(prompt)` with no explicit LLM options passed, so the model used its default temperature (the raw response shows `temperature: 1`).
- The Moment Graph narrative query path did not return early (no matched trails or subject timeline was used for this query), so the answer was not generated from macro moment summaries.

Likely cause:

- Namespace isolation for indexing was set per resync call (admin resync temporarily sets the worker env namespace for that request), but `/rag/query` does not accept a per-request namespace override. Setting `MOMENT_GRAPH_NAMESPACE=...` in the shell running `scripts/query.sh` does not change the already-running dev server's env.
- As a result, the narrative path probably searched a different namespace than the one used during the resync indexing run, and then the query fell back to Evidence Locker retrieval.

### 2025-12-15 - Decision: Moment Graph-only querying during cross-source validation

Observed:

- Query results were dominated by Evidence Locker contexts and did not reflect the Moment Graph macro summaries (and their canonical tokens).

Decision:

- Disable Evidence Locker during query validation for this task, so the query path either:
  - answers from the Moment Graph narrative path, or
  - returns a short "no timeline match" message instead of falling back to chunk retrieval.

Change:

- `/rag/query` now accepts `momentGraphNamespace` (or `namespace`) in the request body, and temporarily sets the worker env namespace for that request, matching the approach used by `/rag/admin/resync`.
- `/rag/query` also accepts an Evidence Locker toggle. When disabled, the engine skips the Evidence Locker retrieval path.
- `scripts/query.sh` now sends `momentGraphNamespace` in the POST body when `MOMENT_GRAPH_NAMESPACE` is set, and can disable Evidence Locker by setting `DISABLE_EVIDENCE_LOCKER=1`.

### 2025-12-15 - Decision update: Hardcode Evidence Locker query path disabled

Change:

- Hardcoded the Evidence Locker query path to be disabled in the engine query function, independent of request flags.

Reason:

- Keeps the validation loop focused on the Moment Graph and linking behavior, and avoids results being dominated by chunk retrieval.

### 2025-12-15 - Query output tweak: ISO8601 timestamps in narrative prompt timeline

Change:

- When building the narrative prompt from Moment Graph moments, each timeline line is prefixed with an ISO8601 timestamp derived from the stored moment createdAt.

Reason:

- Makes chronological ordering explicit in the text the model sees during narrative answering, without changing stored moment titles/summaries.

### 2025-12-15 - Query investigation: namespace not reaching handler

Observed:

- Queries in the test namespace returned "No Moment Graph subject timeline matched this query. Evidence Locker is disabled."

Finding:

- The query input validation interruptor parsed the POST body as `{ query?: string }` and stored that as the parsed body. This dropped `momentGraphNamespace` from the request body before the query handler ran.

Change:

- The interruptor now parses the body as a generic JSON object and preserves all fields in the parsed body so `momentGraphNamespace` can be applied per request.
- Added narrative-path debug logs in the query function to print the namespace, match counts, and whether it fell through.
