# Step 1 (Chats): Preprocess Slack/Discord Logs

Before prompting, normalize your chat export so downstream steps are reliable.

## Recommended normalized message shape
```json
{
  "id": "m_1723456789.123",
  "ts": "2025-09-21T12:34:56Z",
  "author": "Justin",
  "channel": "#dev",
  "text": "Message text with `inline code` and ```\ncode fences\n``` preserved",
  "thread_ts": "1723456000.000",
  "reply_to": "m_1723456000.000",
  "mentions": ["@peter", "@amy"],
  "reactions": [{"name": "+1", "count": 3, "users": ["amy","peter","chris"]}],
  "files": [{"name":"screenshot.png","type":"image","url":"..."}],
  "edited": {"by": "Justin", "ts": "2025-09-21T12:40:00Z"},
  "system_event": null
}
```

## Preprocessing rules
1. **Chronology & numbering**: sort by timestamp; assign sequential `line` numbers; keep original `id`.
2. **Thread reconstruction**: group by `thread_ts`; if absent, treat as top-level; preserve `channel`.
3. **Edits/Deletes**: keep latest visible text; note `"edited"`; ignore hard-deleted content.
4. **De-dup cross-posts**: collapse obvious duplicates; keep a single canonical message id.
5. **Markdown**: normalize to plain text; **preserve code fences** and inline code; strip formatting artifacts.
6. **Emojis/Reactions**: drop decorative emojis; map 👍/👎 to `+1`/`-1`; keep reaction counts.
7. **Attachments**: keep filenames and types; drop raw binaries; retain URLs if needed later.
8. **Mentions**: standardize to lowercase handles; strip `<@U123>` → `@username` if you have a directory.
9. **Timestamps**: convert to ISO 8601 (UTC).

## Output for prompting
Create a flat, chronologically ordered transcript with `line` numbers:
```
1  [2025-09-21 12:34] #dev Justin: We should migrate Postgres → D1?
2  [2025-09-21 12:35] #dev Amy: Concerned about staging readiness.
3  [2025-09-21 12:36] #dev Justin: ```sql\nSELECT 1;\n``` 
...
```
Include a sidecar mapping `{ line → message.id }` if you want to later emit `evidence_message_ids`.
