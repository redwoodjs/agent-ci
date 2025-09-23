# Step 2 (Pull Requests): Segment PR Discussion by Subject

**System instruction**  
You analyze PR content (title, body, commits, comments, reviews) and split the discussion into subject-based segments.

**User instruction template**
```
You are given a normalized PR discussion with line-numbered messages.

Identify subject-based segments.

Rules:
1) Start a new segment when the main subject changes (bug cause, fix details, CI failure, test coverage request, performance regression, doc changes, etc.).
2) Merge across threads if semantically the same subject (e.g., all CI errors about the same failing job).
3) Keep segments contiguous by line numbers; if the same subject reappears later, open a new segment with "(revisit)".
4) Do not summarize yet — only detect boundaries and assign a descriptive title.

For each segment, output:
- "title": subject (max 10 words).
- "start_line": first line number.
- "end_line": last line number.
- "evidence_turns": representative line numbers.
- Optional metadata:
  - "files": file paths from diffs or mentioned in comments
  - "commits": commit SHAs
  - "participants": people involved
  - "thread_keys": involved thread keys
  - "time_start": ISO 8601 of first message
  - "time_end": ISO 8601 of last message

Output JSON only:
{
  "segments": [
    {
      "title": "string",
      "start_line": number,
      "end_line": number,
      "evidence_turns": [numbers...],
      "files": ["packages/runtime/build.ts"],
      "commits": ["abc123"],
      "participants": ["peter", "justin"],
      "thread_keys": ["general"],
      "time_start": "2025-09-20T11:05:00Z",
      "time_end": "2025-09-20T12:00:00Z"
    }
  ]
}

Transcript:
<INSERT PR DISCUSSION HERE>
```