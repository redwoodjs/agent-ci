import { route } from "rwsdk/router";
import { env } from "cloudflare:workers";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { db } from "@/db";

const MEETING_PROMPT = `\
# Transcript Subject Extraction Prompt — Single-Subject Only (No Preferred Title)

You are given a multi-line transcript of programmers talking. Each line may start with a timestamp or speaker tag (e.g., "09:32 Justin:"), but **you must index lines using 1-based line numbers** based on order in the input.

---

## Task (Single-Subject Only)

Collapse the entire conversation into **one dominant technical subject** and keep it traceable to the lines in which it appears.

### 1) Subject Synthesis

- Always emit **exactly one** subject.
- **Title**: Synthesize using the pattern **Gerund + object + context**, e.g., “Fixing RequestInit in route handling”.
  - If no clear context, omit it: “Fixing RequestInit”.
- The title should be compact, specific, and technically accurate.

### 2) Facets & Aliases

- Preserve detail via a \`facets\` array capturing the main sub-topics you collapsed (APIs, legacy options, error behaviors, types, config knobs, architectural components).
- Build an \`aliases\` array of observed surface forms and close variants (synonyms, code identifiers, paraphrases). Normalize by:
  - Case-insensitive matching
  - Singularize nouns
  - Strip punctuation and code syntax that doesn’t change meaning (backticks, (), []).
- Examples of collapsing under one subject:
  - \`response.status\`, \`response.headers\`, \`headers.set\`, \`options.headers\`, \`per-request Response\` → **HTTP response / RequestInit implementation** (depending on context).
  - Keep **distinct subsystems** as facets rather than separate subjects (e.g., “Cloudflare KV” vs “Cloudflare R2” remain distinct **facets** only if both are materially part of the same implementation topic).

### 3) Line Mapping (strict)

- Use **1-based line numbers only**. **Ignore timestamps/speaker tags** when reporting \`lines\`.
- Count each newline-delimited line starting at 1.
- A line “mentions” the subject if it includes the synthesized subject, any alias, a clear paraphrase, or an **unambiguous facet**.
- Include pronoun-only references **if they unambiguously point to the subject within the next 1–2 lines**.

### 4) Scoring

- Set \`score\` to \`1.0\` (the conversation is treated as one dominant theme).

### 5) Output (JSON only)

Return **only** valid JSON in this schema (no markdown, no commentary):

\`\`\`json
{
  "subject": {
    "name": "<synthesized title>",
    "facets": ["<facet 1>", "<facet 2>", "..."],
    "aliases": ["<variant1>", "<variant2>", "..."],
    "lines": [1, 2, 3],
    "score": 1.0
  },
  "alias_map": {
    "<variant>": "<synthesized title>"
  },
  "meta": {
    "total_lines": 0,
    "notes": "Single-subject extraction with synthesized title; all technical mentions collapsed."
  }
}
\`\`\`

### 6) Quality Rules

- Keep the title **compact but specific** (prefer “Fixing RequestInit in route handling” over “Improving the thing about Response stuff”).
- Do **not invent** facts not supported by the transcript.
- Be consistent: once a facet/alias is mapped under the subject, apply that everywhere.
- Prefer concrete API/type names (e.g., RequestInit, Response, RequestInfo) and well-known platform terms (e.g., HTTP response).

---

## Tiny Example

_Transcript (4 lines):_

\`\`\`
1 Peter: We should let interruptors set response.status directly.
2 Justin: If a single Response instance is shared, headers.set works too.
3 Herman: Could we rely on RequestInit from MDN for the contract?
4 Peter: Then deprecate options.headers and prefer the per-request Response.
\`\`\`

_Expected JSON (abbrev):_

\`\`\`json
{
  "subject": {
    "name": "Fixing RequestInit in route handling",
    "facets": [
      "HTTP response (status, headers)",
      "Per-request Response instance",
      "options.headers deprecation",
      "RequestInit contract"
    ],
    "aliases": [
      "response.status",
      "headers.set",
      "Response",
      "Response instance",
      "RequestInit",
      "options.headers",
      "per-request Response"
    ],
    "lines": [1, 2, 3, 4],
    "score": 1.0
  },
  "alias_map": {
    "response.status": "Fixing RequestInit in route handling",
    "headers.set": "Fixing RequestInit in route handling",
    "Response": "Fixing RequestInit in route handling",
    "Response instance": "Fixing RequestInit in route handling",
    "RequestInit": "Fixing RequestInit in route handling",
    "options.headers": "Fixing RequestInit in route handling",
    "per-request Response": "Fixing RequestInit in route handling"
  },
  "meta": {
    "total_lines": 4,
    "notes": "Single-subject extraction; all relevant mentions collapsed."
  }
}
\`\`\`
`;

const PR_PROMPT = `\
# PR Subject Extraction Prompt — Single-Subject Only (No Preferred Title)

You are given a GitHub Pull Request log in JSON. It contains the PR title, body, commits, comments, reviews, and metadata.

---

## Task (Single-Subject Only)

Collapse the entire PR into **one dominant technical subject** and keep it traceable to the fields in which it appears.

### 1) Subject Synthesis

- Always emit **exactly one** subject.
- **Title**: Synthesize using the pattern **Gerund + object + context**, e.g., “Allowing response status and headers modification”.
  - If no clear context, omit it.
- The title should be compact, specific, and technically accurate.

### 2) Facets & Aliases

- Preserve detail via a \`facets\` array capturing the main sub-topics you collapsed (APIs, error behaviors, types, config knobs, architectural components).
- Build an \`aliases\` array of observed surface forms and close variants (synonyms, code identifiers, paraphrases). Normalize by:
  - Case-insensitive matching
  - Singularize nouns
  - Strip punctuation and code syntax that doesn’t change meaning (backticks, (), []).
- Examples of collapsing under one subject:
  - \`response.status\`, \`response.headers\`, \`headers.set\`, \`options.headers\`, \`Response object\` → **Modifying HTTP response** (depending on context).
  - Keep **distinct subsystems** as facets rather than separate subjects (e.g., “renderToString” vs “renderToStream” as facets if they are both part of the same implementation topic).

### 3) Field Mapping (strict)

- Use a \`fields\` array instead of \`lines\`.
- A field “mentions” the subject if it includes the synthesized subject, any alias, a clear paraphrase, or an **unambiguous facet**.
- Report fields using the path syntax:
  - \`"title"\`
  - \`"body"\`
  - \`"commits[0].message"\`
  - \`"comments[1].text"\`
  - \`"reviews[0].state"\`

### 4) Scoring

- Set \`score\` to \`1.0\` (the PR is treated as one dominant theme).

### 5) Output (JSON only)

Return **only** valid JSON in this schema (no markdown, no commentary):

\`\`\`json
{
  "subject": {
    "name": "<synthesized title>",
    "facets": ["<facet 1>", "<facet 2>", "..."],
    "aliases": ["<variant1>", "<variant2>", "..."],
    "fields": ["body", "title", "comments[0].text"],
    "score": 1.0
  },
  "alias_map": {
    "<variant>": "<synthesized title>"
  },
  "meta": {
    "total_fields": 0,
    "notes": "Single-subject extraction with synthesized title; all technical mentions collapsed."
  }
}
\`\`\`
`;

export const contextStreamRoutes = [
  // We will rename this to artifact, we will then dynamically determine how to parse a new artifact type.
  route("/meetings/:artifactID", async function ({ params }) {
    const artifactID = params.artifactID;

    const artifact = await db
      .selectFrom("artifacts")
      .selectAll()
      .where("id", "=", artifactID)
      .executeTakeFirstOrThrow();

    // grab bucket from artifact.

    const rawKey = artifact.bucketPath + "raw.md";
    const subjectKey = artifact.bucketPath + "subject.json";

    console.log("rawKey", rawKey);

    const file = await env.MACHINEN_BUCKET.get(rawKey);
    const content = await file?.text();
    if (!content) {
      return new Response(`File "${rawKey}" not found`, { status: 404 });
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

    const subject = JSON.parse(response.text);

    await db
      .insertInto("subjects")
      .values({
        // @ts-ignore
        id: null,
        name: subject.subject.name,
        artifactID,
        bucketPath: artifact.bucketPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .execute();

    await env.MACHINEN_BUCKET.put(subjectKey, response.text, {
      httpMetadata: {
        contentType: "application/json",
      },
      customMetadata: {
        context: rawKey,
      },
    });

    // I'm kinda conflating subject and entry here.

    return new Response(response.text, {
      headers: {
        "Content-Type": "application/json",
      },
    });
  }),
  route("/prs/:artifactID", async function ({ params }) {
    // redwoodjs-sdk-pr-663
    // redwoodjs-sdk-pr-713
    // redwoodjs-sdk-pr-752
    const artifactID = params.artifactID;

    const artifact = await db
      .selectFrom("artifacts")
      .selectAll()
      .where("id", "=", artifactID)
      .executeTakeFirstOrThrow();

    const rawKey = artifact.bucketPath + "raw.json";
    const subjectKey = artifact.bucketPath + "subject.json";

    const file = await env.MACHINEN_BUCKET.get(rawKey);
    const content = await file?.text();
    if (!content) {
      return new Response(`File "${rawKey}" not found`, { status: 404 });
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

    const subject = JSON.parse(response.text);

    await db
      .insertInto("subjects")
      .values({
        // @ts-ignore
        id: null,
        name: subject.subject.name,
        artifactID,
        bucketPath: artifact.bucketPath,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .execute();

    await env.MACHINEN_BUCKET.put(subjectKey, response.text, {
      httpMetadata: {
        contentType: "application/json",
      },
      customMetadata: {
        context: rawKey,
      },
    });

    return new Response(response.text, {
      headers: {
        "Content-Type": "application/json",
      },
    });
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
