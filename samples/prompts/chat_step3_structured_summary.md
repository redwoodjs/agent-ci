# Step 3 (Chats): Summarize Each Chat Segment into Structured JSON

**System instruction**  
You transform a chat segment into a structured summary for later retrieval, alignment to PRs/commits, and audit trails.

**User instruction template**
```
You are given a chat segment (subset of the transcript) with line numbers.

Create a JSON object for this segment with fields:
- "title": short subject (max 10 words).
- "summary": 2–4 sentences (issue → exploration → resolution/status).
- "entities": people, products, libraries, repos, file paths, issue/PR numbers.
- "actions": explicit follow-ups formatted "Person: action". Parse assignments from phrasing like "I'll", "Can you", "TODO".
- "decisions": clear decisions; infer consensus from affirmations or +1 reactions (threshold ≥2).
- "tags": 3–6 lowercase keywords.
- "evidence_turns": representative line numbers.
- "start_line": first line number.
- "end_line": last line number.

Optional chat metadata (include if available):
- "channels": ["#dev", "#release"]
- "thread_ids": ["1723456000.000"]
- "participants": ["Peter", "Amy", "Justin"]
- "time_start": ISO 8601
- "time_end": ISO 8601
- "attachments": filenames/types if relevant

Output only valid JSON in:
{
  "segments": [
    {
      "title": "string",
      "summary": "string",
      "entities": ["..."],
      "actions": ["Person: ..."],
      "decisions": ["..."],
      "tags": ["..."],
      "evidence_turns": [numbers...],
      "start_line": number,
      "end_line": number,
      "channels": ["#dev"],
      "thread_ids": ["..."],
      "participants": ["..."],
      "time_start": "2025-09-21T12:34:00Z",
      "time_end": "2025-09-21T12:42:00Z",
      "attachments": ["screenshot.png"]
    }
  ]
}

Guidance:
- Normalize references: "PR #123" → "pr#123"; GitHub issues → "gh#123"; file paths remain as-is.
- Preserve code identifiers and file paths in entities (e.g., "src/db/migrate.sql", "useId").
- Prefer declarative phrasing; avoid chat filler.
```