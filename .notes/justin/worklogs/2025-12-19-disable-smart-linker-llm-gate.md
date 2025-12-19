## Problem
Smart Linker attachment decisions are gated by an LLM yes/no classifier for mid-confidence similarity matches.

This adds latency and can block cross-source attachment when the embedding match is relevant but the classifier decides the relationship is not exact enough.

## Plan
- Disable the LLM gate in Smart Linker attachment decisions.
- Use only similarity score thresholding (plus existing namespace/time filtering and candidate ranking).
- Keep logging so attachment decisions can still be inspected.

## Progress
- Updated Smart Linker to skip the LLM yes/no step and use only the similarity score cutoff.
