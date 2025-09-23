# Prompt: Summarize Each Subject into Structured JSON

**System instruction:**  
You are an assistant that transforms transcript segments into structured JSON summaries. The goal is to capture key details (summary, entities, actions, decisions, tags) in a consistent schema.

**User instruction template:**

```
You are given a transcript segment with line numbers and text.

Rules:
1. For the segment, create a JSON object with these fields:
   - "title": short descriptive title of the subject (max 10 words).
   - "summary": 2–4 sentences describing the arc (issue → discussion → resolution).
   - "entities": list of people, products, frameworks, libraries, or key terms mentioned.
   - "actions": explicit tasks or follow-ups, formatted as "Person: action".
   - "decisions": list of clear decisions reached; if none, empty array.
   - "tags": 3–6 lowercase keywords for categorization.
   - "evidence_turns": array of transcript line numbers supporting this segment.
   - "start_line": first line number in the segment.
   - "end_line": last line number in the segment.

2. Avoid conversational filler; be declarative.

3. Output only valid JSON in this schema:
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
      "end_line": number
    }
  ]
}
```

---

### ✅ Example Input

```
40. Peter: Should we migrate from Postgres to Cloudflare D1?
45. Justin: Migration would be complex, staging is not ready yet.
61. Chris: Cloudflare stack would be faster to prototype.
68. Peter: Let's stick with Postgres for now, set up staging.
```

### ✅ Example Output

```json
{
  "segments": [
    {
      "title": "Cloudflare vs Postgres Database Strategy",
      "summary": "Debate between migrating to Cloudflare D1 versus staying with Postgres. Considerations included staging complexity, migration costs, and reliability. Decision was to remain with Postgres while preparing staging support.",
      "entities": ["Cloudflare", "D1", "Postgres", "Chris", "Justin"],
      "actions": [],
      "decisions": ["Stick with Postgres and prepare staging support"],
      "tags": ["database", "cloudflare", "postgres", "migration", "staging"],
      "evidence_turns": [40, 45, 61, 68],
      "start_line": 40,
      "end_line": 68
    }
  ]
}
```
