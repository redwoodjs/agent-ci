export const DISCORD_CONVERSATION_PROMPT = `
# Discord Conversation Subject Extraction

You are given a Discord conversation with messages from multiple participants. Each line may start with a timestamp and author tag (e.g., "[2024-10-23T14:30:00Z] username:").

## Task

Extract **one dominant technical subject** from the conversation and map it to specific lines.

### 1) Subject Synthesis

- Always emit **exactly one** subject.
- **Title**: Synthesize using the pattern **Gerund + object + context**, e.g., "Discussing authentication middleware changes".
  - If no clear context, omit it: "Discussing authentication".
- The title should be compact, specific, and technically accurate.
- For Discord conversations, consider:
  - Thread structure (replies create sub-discussions)
  - Multiple participants contributing different perspectives
  - Mix of technical details, questions, and clarifications
  - Announcements vs discussions vs support requests

### 2) Facets & Aliases

- Preserve detail via a \`facets\` array capturing the main sub-topics (APIs, features, bugs, config, architecture).
- Build an \`aliases\` array of observed surface forms and close variants (synonyms, code identifiers, paraphrases). Normalize by:
  - Case-insensitive matching
  - Singularize nouns
  - Strip punctuation and code syntax that doesn't change meaning (backticks, (), []).
- Examples:
  - \`middleware\`, \`interruptor\`, \`request handler\` → **Request processing middleware** (depending on context).
  - Keep **distinct subsystems** as facets rather than separate subjects.

### 3) Line Mapping (strict)

- Use **1-based line numbers only**. **Ignore timestamps/author tags** when counting lines.
- Count each newline-delimited line starting at 1.
- A line "mentions" the subject if it includes the synthesized subject, any alias, a clear paraphrase, or an **unambiguous facet**.
- Include pronoun-only references **if they unambiguously point to the subject within the next 1-2 lines**.
- For threaded replies (lines starting with ">"), treat them as regular lines but note thread relationships.

### 4) Conversation Context

- Consider the conversation flow:
  - Initial question or announcement
  - Follow-up questions and clarifications
  - Proposed solutions or implementations
  - Decisions or conclusions
- Weight messages from the main thread higher than tangential sub-threads.
- Identify if this is:
  - A technical discussion (implementation details, architecture)
  - A support request (bug report, help needed)
  - An announcement (release notes, updates)
  - A feature request (new functionality discussion)

### 5) Scoring

- Set \`score\` to \`1.0\` (the conversation is treated as one dominant theme).

### 6) Output (JSON only)

Return **only** valid JSON in this schema (no markdown, no commentary):

\`\`\`json
{
  "subject": {
    "name": "<synthesized title>",
    "facets": ["<facet 1>", "<facet 2>", "..."],
    "aliases": ["<variant1>", "<variant2>", "..."],
    "lines": [1, 2, 3],
    "score": 1.0,
    "conversationType": "discussion" | "support" | "announcement" | "feature_request"
  },
  "alias_map": {
    "<variant>": "<synthesized title>"
  },
  "meta": {
    "total_lines": 0,
    "participant_count": 0,
    "thread_count": 0,
    "notes": "Single-subject extraction from Discord conversation; all technical mentions collapsed."
  }
}
\`\`\`

### 7) Quality Rules

- Keep the title **compact but specific** (prefer "Implementing webhook authentication" over "Talking about the webhook thing").
- Do **not invent** facts not supported by the conversation.
- Be consistent: once a facet/alias is mapped under the subject, apply that everywhere.
- Prefer concrete API/type names (e.g., RequestInit, Response, authenticate) and well-known technical terms.
- For multi-participant discussions, focus on the convergent topic rather than individual tangents.

## Example

_Conversation (4 lines):_

\`\`\`
1 [2024-10-23T14:30:00Z] alice: We should add rate limiting to the API endpoints
2 [2024-10-23T14:31:15Z] bob: > @alice Good idea. Should we use a token bucket algorithm?
3 [2024-10-23T14:32:00Z] alice: Token bucket works well for burst traffic
4 [2024-10-23T14:33:45Z] charlie: I can implement the rate limiter middleware this week
\`\`\`

_Output:_

\`\`\`json
{
  "subject": {
    "name": "Implementing API rate limiting",
    "facets": ["rate limiting", "token bucket algorithm", "API endpoints", "middleware"],
    "aliases": ["rate limit", "rate limiter", "rate limiting", "token bucket"],
    "lines": [1, 2, 3, 4],
    "score": 1.0,
    "conversationType": "discussion"
  },
  "alias_map": {
    "rate limit": "Implementing API rate limiting",
    "rate limiter": "Implementing API rate limiting",
    "token bucket": "Implementing API rate limiting"
  },
  "meta": {
    "total_lines": 4,
    "participant_count": 3,
    "thread_count": 1,
    "notes": "Technical discussion about adding rate limiting feature to API"
  }
}
\`\`\`
`;
