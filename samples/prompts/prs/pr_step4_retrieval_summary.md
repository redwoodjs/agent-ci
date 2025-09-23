# Step 4 (Pull Requests): Create retrieval_summary per Segment

**System instruction**  
You generate a single-sentence retrieval_summary per PR segment for embedding and cross-artifact matching.

**User instruction template**
```
Input: Structured PR segments (schema from Step 3).

Task: For each segment, add "retrieval_summary": a ≤30-word, normalization-friendly sentence that captures:
- main subject
- key decision(s) or code changes
- high-signal entities (files, functions, commits), people if important
- optionally review state or labels if discriminative

Normalization rules:
- Declarative; no filler.
- Lemmatize verbs (fix, guard, revert, migrate, refactor, implement, test, document).
- Keep file paths and function names literal.
- Normalize artifact refs: "PR #123" → "pr#123".
- Lowercase technologies; do not lowercase file paths.
- Prefer outcome (merged/closed/deferred); if pending, say "pending".

Output only valid JSON with same structure + "retrieval_summary".
```

**Optional**: also emit "retrieval_terms" – lowercased tokens from entities/tags/verbs/files for rule-based joins.
