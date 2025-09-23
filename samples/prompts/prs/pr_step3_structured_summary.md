# Step 3 (Pull Requests): Structured Summary per Segment

**System instruction**  
You convert a PR segment into a structured summary that captures code-level changes, discussions, and outcomes.

**User instruction template**
```
Input: one PR segment (subset of line-numbered discussion).

Create JSON with fields:
- "title": short subject (max 10 words).
- "summary": 2–5 sentences (problem → code change → outcome).
- "entities": people, repos, packages, file paths, functions, CI jobs, commit SHAs.
- "actions": follow-ups, formatted "Person: action" (e.g., "Reviewer: request test coverage").
- "decisions": concrete outcomes (e.g., "accept guard clause in build.ts").
- "tags": 3–6 lowercase keywords (e.g., build, ci, bugfix, performance, docs, refactor).
- "evidence_turns": representative line numbers.
- "start_line": first line.
- "end_line": last line.

Optional metadata:
- "files": ["packages/runtime/build.ts"]
- "commits": ["abc123"]
- "participants": ["peter","justin"]
- "review_state": "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"
- "labels": ["bug","deployment"]
- "state": "open" | "closed" | "merged"

Output only valid JSON with this schema:
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
      "files": ["..."],
      "commits": ["..."],
      "participants": ["..."],
      "review_state": "APPROVED",
      "labels": ["..."],
      "state": "merged"
    }
  ]
}
```