## PR title

Cross-Source Smart Linking Validation & Narrative Context

## Smart Linking Validation

We wanted to validate that **Smart Linking** (our semantic correlation step that stitches new docs onto existing timelines) worked across different data sources like GitHub and Discord.

**The good news:** It "just worked". We successfully stitched a Discord discussion about a feature onto the corresponding GitHub Issue without touching the linking logic.

**The bad news:** The resulting narrative was a mess to read. It was hard to tell which part came from Discord vs GitHub, generic summaries claimed things were "implemented" when they were just proposed, and our retrieval often missed the attached branches.

To fix the display and usability of this linked data, we made three main changes:

## 1. Canonical References & Source Identity

We need to know exactly where an event came from without hoping the LLM remembers the URL.
- Added **Canonical Reference Tokens** (`mchn://<source>/<type>/<path>`) and source labels like `[GitHub Issue]`.
- Created a plugin hook (`getMacroSynthesisPromptContext`) to inject these into synthesis - this allows each data source (cursor, discord, github) to provide its own prompting for the macro moment sythesis
- Tightened prompts to force these labels into titles and summaries.

We'll use the references by replacing them with relevant URL in a future PR.

## 2. Context-Aware Summarization & Actor Attribution

Generic summaries were getting it wrong (e.g. saying "Implemented X" for a proposal) and missing who said what.
- **Framing:** Added `getMicroMomentBatchPromptContext` so plugins can tell the summarizer to use "Proposed" for Issues or "Changed" for PRs.
- **Actors:** Normalized author names (like `@handle`) in chunks so we can attribute quotes correctly.

## 3. Narrative Retrieval: Root-to-Leaf Timelines

Our old "ancestor trail" search was missing attached child branches. If you matched the GitHub Issue, you'd miss the Discord thread hanging off it.

We switched to **Root-to-Leaf**:
1.  **Match:** Find a relevant moment.
2.  **Resolve Root:** Find its root Subject.
3.  **Expand:** Pull the **whole descendant timeline**.

Now we get the full picture (PRs, Discord threads, comments) no matter which part triggered the match.

## Dev Tools & Test Isolation

- **Namespace Querying:** Updated `/rag/query` to accept a `momentGraphNamespace` so we can query our isolated test runs.
