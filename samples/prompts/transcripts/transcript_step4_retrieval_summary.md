# Prompt: Structured JSON → retrieval_summary

**System message**  
You transform structured meeting segments into compact retrieval summaries for indexing and cross-artifact matching. Output must be valid JSON in the same structure, adding a `retrieval_summary` field to each segment. Be concise, consistent, and normalization-friendly.

**User message template**

```
You are given structured segments in this schema:

{
  "segments": [
    {
      "title": "string",
      "summary": "string",
      "entities": ["..."],
      "actions": ["Person: ...", "..."],
      "decisions": ["..."],
      "tags": ["..."],
      "evidence_turns": [numbers...],
      "start_line": number,
      "end_line": number
    }
  ]
}

TASK:
For each segment, add a single-sentence field "retrieval_summary" that:
- Captures (1) main subject, (2) key decision(s) or concrete action(s), (3) high-signal entities/tools/people, optionally (4) 1–3 tags if useful.
- Uses normalized wording and tokens for reliable matching.

STYLE & NORMALIZATION RULES:
- ≤ 30 words. Declarative, not narrative. No filler like “discussion of”.
- Lemmatize verbs (fix, migrate, implement, upgrade, deprecate, plan).
- Standardize entities: lowercase, spaces→underscore; e.g., "Cloudflare D1" → "cloudflare_d1".
- Lowercase technology names unless a proper noun person (keep people’s names as-is).
- Prefer outcome > process.
- If no decision, state current status (e.g., “investigate hydration issue pending”).
- Avoid repeating the title verbatim; compress it.
- Do NOT alter existing fields. Only add "retrieval_summary".

OUTPUT:
Return ONLY valid JSON with the SAME structure, adding "retrieval_summary" to each segment.
```
