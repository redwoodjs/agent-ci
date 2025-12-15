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

### 2025-12-15 - Implementation kickoff

Next step is implementation. Per repo process, I updated architecture docs first to reflect the planned canonical token format and the macro synthesis prompt hook that provides source-specific formatting and reference context.

Docs updated:

- `docs/architecture/knowledge-synthesis-engine.md`
- `docs/architecture/plugin-system.md`
- `docs/architecture/system-flow.md`

### 2025-12-15 - Implementation status (in progress)

Changes made:

- Added a plugin hook for macro synthesis prompt context so each source plugin can provide:
  - title label formatting guidance
  - canonical token shapes
  - concrete reference tokens for the current document (capped lists for comments/messages)
- Wired the engine to call this hook before macro synthesis and pass the returned text into the macro synthesis prompt.
- Updated the macro synthesis prompt to include:
  - generic formatting rules for canonical tokens
  - the per-source plugin-provided block

### 2025-12-15 - Implementation note (title labels and natural summary descriptors)

Macro synthesis prompt formatting rules now support:

- `title_label`: used as the bracket label at the start of each macro moment title (example: `[GitHub Pull Request #530]`).
- `summary_descriptor`: used as the natural-language prefix at the start of each macro moment summary (example: `In a GitHub pull request (#530), ...`).

Each plugin's macro synthesis prompt context hook now provides these fields where possible.

### 2025-12-15 - Implementation note (macro synthesis prompt: hard requirements)

The macro synthesis prompt rules were tightened to require exact usage of values provided by the plugin context:

- Title must begin with the exact `title_label` value when provided.
- Summary must begin with the exact `summary_descriptor` value when provided.
- Summary must include the `document_ref` token in brackets exactly once when provided.

### 2025-12-15 - Implementation note (prompt compliance iteration)

Observed from local runs on `github/redwoodjs/sdk/issues/552/latest.json`:

- The macro synthesis output sometimes omitted `title_label` and the bracketed `document_ref` token, even when they were present in the plugin-provided context.

Change:

- The macro synthesis prompt now includes a short "Resolved requirements" block that repeats the extracted `title_label`, `summary_descriptor`, and `document_ref` values.
- Macro synthesis temperature was set to 0 to reduce format drift.
- The engine now logs the full macro synthesis prompt context block for inspection in dev logs.

### 2025-12-15 - Implementation note (macro synthesis context hook scope)

The per-source macro synthesis prompt context hook is now used for more than references and formatting. Plugins can also provide narrative context guidance that shapes how the macro summary is written (example: issue text as proposal/discussion vs PR text as changes/review).

### 2025-12-15 - Implementation note (micro summaries: avoid false "implemented" claims)

Observed:

- GitHub issue text often describes intent (problem statement, proposal, request), but micro summaries were phrased as completed work ("implemented", "added").

Change:

- Kept micro summarization centralized in the default plugin.
- Added document-type-aware prompt context for GitHub chunks:
  - For issue chunk types, prefer proposal/discussion verbs unless the text explicitly states completion.
  - For pull request chunk types, describe changes/review, but still avoid claiming user-visible shipping unless explicitly stated.

Update:

- Moved GitHub micro-moment summarization rules into the GitHub plugin (first-match for GitHub docs).
- Default plugin micro summarization is generic again.

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

- The engine batches chunks (size and character caps), then calls the first-match hook `computeMicroMomentsForChunkBatch`.
- Only the default plugin currently implements this hook, so it acts as the shared micro-moment summarizer across sources.
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
  - github: `github:issue/<owner>/<repo>/<number>` and `github:pr/<owner>/<repo>/<number>`
  - discord: `discord:thread/<guildid>/<channelid>/<threadid>` (and optionally a message token later)
  - Cursor: either no ref token, or a generic label without an id
- Inject a source label + bracket token into the stored macro moment text deterministically, not via synthesis:
  - Prefix the moment title or summary with something like:
    - `Discord thread [discord:thread/<guildid>/<channelid>/<threadid>] - <title>`
    - `GitHub issue [github:issue/<owner>/<repo>/<number>] - <title>`
  - This keeps query-time output consistent without requiring special prompt instructions.

Open question:

- Whether to inject the label+token at indexing time (stored on the moment) or at query time (formatted into the LLM context and/or appended after).

### 2025-12-15 - Plan: canonical reference format (source:document_type/path)

Decision:

- Use a readable canonical reference token format that is consistent across sources.
- Inject the label + canonical reference into macro moments at storage time (deterministic, not LLM-generated).

Format:

- `source:document_type/<path>`

Notes:

- Use lowercase `github` and `discord` for readability and consistency.
- Keep the path format stable and parseable. Avoid punctuation variants like `#` or `!` to reduce ambiguity.

GitHub token formats:

- issue:
  - `github:issue/<owner>/<repo>/<number>`
  - example: `github:issue/redwoodjs/sdk/552`
- pull request:
  - `github:pr/<owner>/<repo>/<number>`
  - example: `github:pr/redwoodjs/sdk/530`
- issue comment:
  - `github:issue_comment/<owner>/<repo>/<number>/<commentid>`
  - example: `github:issue_comment/redwoodjs/sdk/552/1234567890`
- pull request comment:
  - `github:pr_comment/<owner>/<repo>/<number>/<commentid>`
  - example: `github:pr_comment/redwoodjs/sdk/530/1234567890`

Discord token formats:

- thread:
  - `discord:thread/<guildid>/<channelid>/<threadid>`
- thread message:
  - `discord:thread_message/<guildid>/<channelid>/<threadid>/<messageid>`
- channel day file (if needed later for backfills):
  - `discord:channel_day/<guildid>/<channelid>/<yyyy-mm-dd>`
- channel message:
  - `discord:channel_message/<guildid>/<channelid>/<yyyy-mm-dd>/<messageid>`

Cursor token formats (tentative):

- For now, include the source label but omit a canonical reference token for Cursor.
- If we later add one, keep it consistent with the above shape:
  - `cursor:conversation/<conversationid>`

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
    - Use `source:document_type/path` as described earlier in this log.
- Section C: plugin-provided source formatting + reference context (hook output, concatenated verbatim)
  - This is where each source plugin can say:
    - “For titles, use this specific bracket label”
    - “When referencing this entity type, use this canonical token shape”
    - “Here are the concrete tokens for this document and its key entities”

Example hook output (GitHub PR):

- Formatting:
  - `title_label: [GitHub Pull Request]`
  - `when_referencing_pr_use: github:pr/<owner>/<repo>/<number>`
  - `when_referencing_pr_comment_use: github:pr_comment/<owner>/<repo>/<number>/<commentid>`
- Reference context:
  - `document_ref: github:pr/redwoodjs/sdk/530`
  - `known_comment_refs:` (optional)
    - `github:pr_comment/redwoodjs/sdk/530/1234567890`
  - `entity_hints:` (optional, natural language)
    - `This PR is in redwoodjs/sdk and is number 530.`

Example hook output (Discord thread):

- Formatting:
  - `title_label: [Discord Thread]`
  - `when_referencing_thread_use: discord:thread/<guildid>/<channelid>/<threadid>`
  - `when_referencing_thread_message_use: discord:thread_message/<guildid>/<channelid>/<threadid>/<messageid>`
- Reference context:
  - `document_ref: discord:thread/<guildid>/<channelid>/<threadid>`
  - `known_message_refs:` (optional)
    - `discord:thread_message/<guildid>/<channelid>/<threadid>/<messageid>`
  - `entity_hints:` (optional)
    - `This is a Discord thread with the ids above.`

Formatting decision (macro synthesis time):

- We rely on prompt instructions + plugin-provided formatting guidance to get source labels and canonical tokens into the title/summary text.

Cursor note:

- Cursor can still use a title label like `[Cursor Conversation]`.
- For now, the summary should omit a canonical token for Cursor (or include a generic token without an id).


