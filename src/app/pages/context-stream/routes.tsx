import { route } from "rwsdk/router";
import { env } from "cloudflare:workers";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const MEETING_PROMPT = `\
You extract canonical technical subjects from a developer transcript.

Return ONLY valid JSON that matches this schema:
{
  "core": string[5..7],        // 5-7 items, each 2-5 words
  "extended": string[0..12]    // 0-12 items, each 2-5 words
}

Hard rules:
- Output must be a single JSON object. No extra text.
- Each subject: 2–5 words, noun phrases only (no verbs/imperatives).
- Normalize synonyms to one phrasing (e.g., "use ResponseInit object" → "ResponseInit").
- Collapse variants to one canonical term (e.g., "headers options deprecation", "deprecate options.headers" → "options.headers deprecation").
- Ignore decisions, questions, action items.
- De-duplicate (case-insensitive) after normalization.
- Prefer domain terms (APIs, components, files, configs).
- If fewer than 5 core subjects exist, put all in "core" and leave "extended": [].

Ranking rules (for putting items in "core"):
1) Problem definition terms
2) Root cause terms
3) Solution strategy terms
4) Critical mechanisms/configs enabling the fix
Everything else → "extended".

Validation rules:
- Each item must match: ^(\\b\\w[\\w\\-\\.]+(?:\\s+\\w[\\w\\-\\.]+){0,4})$
- No trailing punctuation, quotes, or code fences.
- No duplicates across "core" and "extended".
`;

const PR_PROMPT = `\
You extract canonical technical subjects from a pull request (title, body, comments, commits).
Return ONLY valid JSON that matches this schema:
{
  "core": string[5..7],
  "extended": string[0..12]
}

Prioritization:
- Primary sources: PR title + body
- Include comments/reviews only if they introduce an important concept
- Ignore commit messages unless they introduce a *new* concept not present elsewhere

Canonicalization:
- 2–5 word noun phrases
- Normalize synonyms (e.g., "useId mismatch", "useId desync" → "useId hydration mismatch")
- Collapse variants; de-duplicate case-insensitively
- Prefer domain terms (APIs, components, configs)

Ranking to "core":
1) Problem
2) Root cause
3) Solution approach
4) Key mechanisms enabling solution
All else → "extended"

Validation:
- Each item matches: ^(\\b\\w[\\w\\-\\.]+(?:\\s+\\w[\\w\\-\\.]+){0,4})$
- No verbs/imperatives, no punctuation tails, no quotes, no code fences
- No overlap between "core" and "extended"
`;

export const contextStreamRoutes = [
  route("/meetings/:meetingID", async function ({ params }) {
    // 2025-09-18-1
    // 2025-09-10-1
    // 2025-07-29-1
    const meetingID = params.meetingID;
    const key = `meetings/${meetingID}/raw.md`;

    const file = await env.MACHINEN_BUCKET.get(key);
    const content = await file?.text();
    if (!content) {
      return new Response("File not found", { status: 404 });
    }

    const response = await generateText({
      model: openai("gpt-5"),
      system: MEETING_PROMPT,
      prompt: content,
      temperature: 0.1,
    });

    console.log("-".repeat(80));
    console.log(response.text);
    console.log("-".repeat(80));

    await env.MACHINEN_BUCKET.put(key, content, {
      customMetadata: {
        context: response.text,
      },
    });

    return new Response("ok");
  }),
  route("/prs/:prID", async function ({ params }) {
    // redwoodjs-sdk-pr-663
    // redwoodjs-sdk-pr-713
    // redwoodjs-sdk-pr-752
    const prID = params.prID;
    const key = `prs/${prID}/raw.json`;

    const file = await env.MACHINEN_BUCKET.get(key);
    const content = await file?.text();
    if (!content) {
      return new Response("File not found", { status: 404 });
    }

    const response = await generateText({
      model: openai("gpt-5"),
      system: PR_PROMPT,
      prompt: content,
      temperature: 0.1,
    });

    console.log("-".repeat(80));
    console.log(response.text);
    console.log("-".repeat(80));

    await env.MACHINEN_BUCKET.put(key, content, {
      customMetadata: {
        context: response.text,
      },
    });

    return new Response("ok");
  }),
  route("/search", async function ({ request }) {
    const url = new URL(request.url);
    const query = url.searchParams.get("q");
    const mode = url.searchParams.get("mode") ?? "ai";
    if (!query) {
      return new Response("No query provided", { status: 400 });
    }

    if (mode === "ai") {
      const answer = await env.AI.autorag("machinen-context-stream").aiSearch({
        query,
        rewrite_query: true,
      });
      return new Response(answer.response);
    } else {
      // first we convert the query to a vector, or do we somehow normalize it?

      const answer = await env.AI.autorag("machinen-context-stream").search({
        query,
        rewrite_query: true,
      });
      return new Response(JSON.stringify(answer.data));
    }
  }),
];
