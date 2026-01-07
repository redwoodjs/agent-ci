# 2026-01-07 - GitHub macro moment noise filtering

## Problem

Even after adding macro prompt constraints and importance gating, the moment graph still contains low-signal GitHub macro moments.

Examples:

- `[GitHub Issue #320] Cloudflare Pages deployment preview`
- `[GitHub Issue #666] Cloudflare Pages bot reported a successful deployment of redwood-sdk-docs`
- `[GitHub Issue #62] Dependabot requested future update handling`
- `[GitHub Issue #101] Closed issue to use new starter`
- `Praise for perfect update`

These are mostly automated status events (deploy/preview/CI/bot output), administrative state changes, or generic praise.

## Context

- GitHub ingestion includes issue bodies, comments, and bot/system updates.
- The GitHub micro-moment prompt context already instructs the synthesizer to treat automated status updates as low-signal.
- Macro synthesis can still promote these to macro moments, and importance gating can keep them if the model scores them above the threshold.

## Plan (initial)

- Identify how these titles are formed in macro synthesis for GitHub issues (prefixing and summary tokens).
- Tighten macro synthesis constraints to explicitly exclude automated/bot status updates and praise.
- Add deterministic post-synthesis filtering so automated/bot/praise moments are dropped even when scored highly.
- Verify the worker builds and the change does not introduce new lints.

## Findings

- GitHub macro titles are required to begin with a per-document prefix (example: `[GitHub Issue #320]`) via macro synthesis prompt context.
- The macro prompt previously excluded social chatter and generic encouragement, but did not explicitly exclude automated bot status updates for GitHub (deploy previews, CI checks, dependency bots).
- Importance-only gating can keep automated status moments if the model assigns them a high importance score.

## Implementation

- Updated macro synthesis prompts to explicitly exclude:
  - automated system/bot status updates (deploy previews, CI status, dependency bot updates)
  - administrative state changes (issue close, labels, assignments) unless tied to a concrete technical decision or implementation change
  - praise/thanks/kudos moments
- Added deterministic post-synthesis filtering in the per-stream gating step:
  - drops GitHub macro moments when the author looks like a bot, or the title/summary match a small set of automation phrases
  - allows overriding/extending patterns via `MACRO_MOMENT_NOISE_PATTERNS` (comma or newline separated regexes)
  - if all macro moments in a stream are filtered out as noise, the stream is skipped

## PR Title: GitHub macro moment noise filtering

### Description

This change improves the signal-to-noise ratio in the knowledge graph by aggressively filtering out low-value GitHub events that previously survived importance gating.

1.  **Stricter Synthesis Prompt**: The macro synthesis prompt now explicitly forbids emitting macro moments for automated status updates (CI, deploy previews, dependabot), administrative churn (issue closing without technical context), and generic praise/kudos.
2.  **Deterministic Noise Filter**: Added a hard filter step before persistence that drops GitHub macro moments if:
    - The author is a bot (e.g., `dependabot`, `[bot]`).
    - The title or summary matches known automation patterns (e.g., "deployment preview", "cloudflare pages", "successful deployment").
    - The moment is purely social (starts with "Praise", "Thanks", "Kudos").
    - The moment is a generic "Closed issue" event without any technical signal words (fix, bug, implement, ship, etc.).

This ensures that even if the LLM assigns high importance to a "successful deployment" notification, it will be dropped before entering the graph.
