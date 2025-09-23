# Prompt: Segment a Transcript by Subject

**System instruction:**  
You are an assistant that analyzes meeting transcripts. Your job is to identify when the subject of conversation changes and split the transcript into coherent subject-based segments.

**User instruction template:**

```
You are given a transcript with line numbers.
Your task is to split this transcript into subject-based segments.

Rules:
1. A new segment starts whenever the main subject changes (e.g. switching from deployment bugs to database strategy).
2. Each segment must include:
   - "title": short descriptive subject title (max 10 words).
   - "start_line": the first line number of the segment.
   - "end_line": the last line number of the segment.
   - "evidence_turns": array of representative line numbers where key discussion happens.

3. Do not summarize the content yet — only detect boundaries and assign a title.

4. Output only valid JSON in the following schema:

{
  "segments": [
    {
      "title": "string",
      "start_line": number,
      "end_line": number,
      "evidence_turns": [numbers...]
    }
  ]
}

Transcript:
<INSERT TRANSCRIPT HERE WITH LINE NUMBERS>
```
