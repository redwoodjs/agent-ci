# Step 4 (Chats): Create retrieval_summary for Each Chat Segment

**System instruction**  
You convert structured chat segments into a single-sentence retrieval summary for embedding and cross-artifact matching.

**User instruction template**
```
Input: JSON structured chat segments (schema from Step 3).

Task: For each segment, add "retrieval_summary": a ≤30-word, normalization-friendly sentence that captures:
- main subject
- key decision(s) or concrete action(s)
- high-signal entities/tools/people; optionally 1–2 tags
- optionally channel or repo token if highly discriminative

Normalization rules:
- Declarative; no filler ("discussion of").
- Lemmatize verbs (fix, migrate, implement, upgrade, plan, investigate).
- Standardize entities: lowercase; spaces and slashes → underscore (e.g., "Cloudflare D1" → "cloudflare_d1").
- Keep people’s names as-is; keep file paths literal; map "PR #123" → "pr#123".
- Prefer outcome over process; if no decision, mark pending.

Output only valid JSON with same structure + "retrieval_summary".
```

**Optionally also emit** `"retrieval_terms"`: a lowercased, deduped token list from entities/tags/verbs for rule-based joins.
