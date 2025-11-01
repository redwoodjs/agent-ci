# Discord to Markdown Conversion Format

## Overview

Converts Discord message JSON exports into structured markdown format that preserves conversation threads, metadata, and interactions while maintaining readability.

**Status:** ✅ IMPLEMENTED in `src/app/ingestors/discord/split-conversations.ts`

The implementation uses the `reply_to_message_id` field to reconstruct thread hierarchies and generates conversation markdown with proper indentation for threaded discussions.

## Format Structure

### Basic Message Format

Current implementation uses ISO 8601 timestamps:

```
[YYYY-MM-DDTHH:MM:SS.sssZ] username: message content
```

Example:

```
[2024-10-23T14:30:00.000Z] alice: We should add rate limiting to the API endpoints
```

### Threaded Conversations

Thread replies are indented with `>` prefix (implemented):

```
[YYYY-MM-DDTHH:MM:SS.sssZ] username: parent message
> [YYYY-MM-DDTHH:MM:SS.sssZ] username: reply message
> [YYYY-MM-DDTHH:MM:SS.sssZ] username: another reply
> > [YYYY-MM-DDTHH:MM:SS.sssZ] username: nested reply
```

The implementation uses the `reply_to_message_id` field from Discord's `message_reference` to build the thread hierarchy recursively.

## Message Elements

### 1. Timestamps

- Format: ISO 8601 converted to `YYYY-MM-DD HH:MM:SS` (UTC)
- Source field: `timestamp`
- Edited messages append: `(edited YYYY-MM-DD HH:MM:SS)`

Example:

```
2025-09-30 18:11:51 | zX0: message content
2025-09-30 18:11:51 | zX0: message content (edited 2025-09-30 18:14:21)
```

### 2. Username

- Primary: `author.global_name` (display name)
- Fallback: `author.username` (handle)
- Format: Plain text, no @ prefix

### 3. Message Content

- Preserve formatting (bold, italic, code blocks)
- Discord markdown syntax maps directly to standard markdown
- Multi-line messages maintain line breaks

### 4. Reactions

Append reactions after message content:

```
YYYY-MM-DD HH:MM:SS | username: message content
  [reactions: 🙌 3, 🚀 2, 💃 2]
```

### 5. Attachments

List attachments with metadata:

```
YYYY-MM-DD HH:MM:SS | username: message content
  [attachment: filename.png, size, url]
```

### 6. Embeds

Include embed metadata:

```
YYYY-MM-DD HH:MM:SS | username: message content
  [embed: title, description, url]
```

### 7. Mentions

Preserve mentions inline:

- User mentions: `@username`
- Role mentions: `@rolename`
- Channel mentions: `#channelname`

### 8. Message Types

Handle special message types:

- Type 0: Regular message
- Type 18: Reply in thread
- Type 19: Reply to message

All render as messages; threading structure handles context.

### 9. Thread Metadata

Add thread header when message starts a thread:

```
YYYY-MM-DD HH:MM:SS | username: parent message
  [thread: "thread title", 5 messages, 2 members]
  > YYYY-MM-DD HH:MM:SS | username: reply
```

## Processing Rules

### Thread Detection

1. Check for `message_reference` field
2. Match `message_id` to parent message's `id`
3. Nest under parent with `>` prefix
4. Increment indent level for nested replies

### Message Ordering

1. Sort messages by `timestamp` ascending (oldest first)
2. Process parent messages before replies
3. Maintain chronological order within thread levels

### Content Sanitization

1. Preserve Discord markdown syntax
2. Escape markdown characters that conflict with format structure
3. Trim excessive whitespace
4. Handle empty/null content fields

### Thread Hierarchy

1. Build parent-child relationships from `message_reference`
2. Support arbitrary nesting depth with `>>`, `>>>`, etc.
3. Separate thread chains with blank line

## Data Mapping

### JSON to Markdown Field Mapping

| Discord JSON Field                       | Markdown Element | Required |
| ---------------------------------------- | ---------------- | -------- |
| `timestamp`                              | Message prefix   | Yes      |
| `author.global_name` / `author.username` | Username         | Yes      |
| `content`                                | Message body     | Yes      |
| `edited_timestamp`                       | Edit annotation  | No       |
| `reactions`                              | Reaction list    | No       |
| `attachments`                            | Attachment list  | No       |
| `embeds`                                 | Embed list       | No       |
| `message_reference`                      | Thread nesting   | No       |
| `thread`                                 | Thread metadata  | No       |

## Example Output

```markdown
2025-09-30 16:23:53 | peterp: Hi Tim, we don't have any helpers for that; we have an open issue to build those - I have been preparing for a massive pitch, which happens in 7 minutes, I can probably get it done tomorrow.

2025-09-30 16:35:51 | Tim Reynolds: Are you planning to have an interface similar to Next? Probably makes sense but use the Path/Route type I saw in router used

> 2025-09-30 18:02:05 | peterp: We could! I'll take a look at that

    [thread: "We could! I'll take a look at that", 15 messages, 4 members]
    >> 2025-09-30 20:40:39 | Tim Reynolds: We could! I'll take a look at that

2025-09-30 18:07:35 | Jürgen Leschner: node_modules in new starter `create-rwsdk` (edited 2025-09-30 18:14:21)
[thread: "node modules in new starter `create-rwsdk`", 5 messages, 2 members]

2025-09-30 18:11:51 | zX0: Had mild panic thinking about upgrading . . . but was 𝘴𝑚𝘰𝑜𝑜𝑜𝑜𝑜𝑜𝑜𝑡ℎ sailing and done within a few mins with zero issues! Nice work Redwood team!
[reactions: 🙌 3, 🚀 2, 💃 2]
```

## Implementation Considerations

### Performance

- ✅ Build message ID lookup table for thread resolution
- ✅ Recursive thread processing with parent-child relationships
- ✅ Single conversation split processing

### Error Handling

- ✅ Try-catch for raw_data JSON parsing with fallback to "unknown"
- ✅ Graceful handling of missing reply parents
- ✅ Null-safe access for thread_id and reply fields

### Storage

- ✅ Output: Plain markdown files stored in R2
- ✅ Path format: `discord/{guildID}/{channelID}/{timestamp}/split-{index}/conversation.md`
- ✅ Metadata stored alongside: `metadata.json` with split details
- ✅ Compatible with existing artifact storage structure

### Database Schema

- ✅ `raw_discord_messages.reply_to_message_id` - stores message reference
- ✅ `raw_discord_messages.reply_to_channel_id` - stores cross-channel references
- ✅ `conversation_splits` table tracks splits with metadata

## Future Extensions

- Link preservation (URLs, channel links)
- Code block syntax highlighting hints
- Poll results formatting
- Voice message transcripts
- Sticker representations
- Multi-channel export aggregation
