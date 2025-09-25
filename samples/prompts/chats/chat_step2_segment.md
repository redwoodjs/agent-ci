# Step 2 (Chats): Segment Slack/Discord Transcript by Subject

**System instruction**  
You analyze multi-user chat logs (Slack/Discord) and split them into subject-based segments. Handle threads, replies, and quick context shifts.

**User instruction template**
```
You are given a chronologically ordered chat transcript with line numbers. 
Identify subject-based segments.

Rules:
1) Start a new segment when the main subject changes OR when a distinct thread diverges materially.
2) Merge parallel messages/threads if they are the same subject (high semantic similarity).
3) Keep segments contiguous by line numbers; if the same subject recurs later, open a new segment with the same title suffix (e.g., "… (revisit)").
4) Do not summarize content yet — only detect boundaries and title.

For each segment, output:
- "title": short subject (max 10 words).
- "start_line": first line number of the segment.
- "end_line": last line number of the segment.
- "evidence_turns": representative line numbers inside the segment.
- Optional chat metadata (include if available):
  - "channels": array of channel names (e.g., ["#dev", "#release"])
  - "thread_ids": array of thread identifiers
  - "participants": array of display names
  - "time_start": ISO 8601 of first message in segment
  - "time_end": ISO 8601 of last message in segment

Output only valid JSON:
{
  "segments": [
    {
      "title": "string",
      "start_line": number,
      "end_line": number,
      "evidence_turns": [numbers...],
      "channels": ["#dev"],
      "thread_ids": ["1723456000.000"],
      "participants": ["Peter", "Justin"],
      "time_start": "2025-09-21T12:34:00Z",
      "time_end": "2025-09-21T12:42:00Z"
    }
  ]
}

Transcript:
<INSERT CHAT LOG WITH LINE NUMBERS>
```

**Notes**
- Treat reaction-only messages as supporting signals, not subject shifts.
- Ignore purely administrative system events unless they change the subject (e.g., topic set).
