import { embedWithWorkersAI } from "./assemble";

// intent.ts
export type Intent = {
  query: string; // normalized query to embed (can just echo user question)
  question_type:
    | "when"
    | "what"
    | "why"
    | "how"
    | "who"
    | "where"
    | "status"
    | "other";
  topic_terms: string[]; // model-chosen salient terms (["dark mode"])
  include_sources?: ("meeting" | "pr" | "issue" | "chat")[];
  date_range?: { start?: string; end?: string }; // ISO 8601 if user mentioned time
  must_match?: string[]; // optional strict filters (e.g., ["radix ui"])
  nice_to_have?: string[]; // soft hints/boosts
};

export const prompt = `
You are an intent parser for a retrieval system with meetings and PR segments.
Return ONLY valid JSON for this schema:

{
  "query": string,
  "question_type": "when" | "what" | "why" | "how" | "who" | "where" | "status" | "other",
  "topic_terms": string[],
  "include_sources": ["meeting","pr","issue","chat"],
  "date_range": {"start": "ISO", "end": "ISO"},
  "must_match": string[],
  "nice_to_have": string[]
}

Rules:
- Keep query natural; don't keyword-ize.
- topic_terms should be 1-4 short phrases that capture the core subject (e.g., ["dark mode"]).
- include_sources: default ["meeting","pr"] unless the question says otherwise.
- date_range: set only if the user mentions specific time windows.
- must_match: add exact phrases only if the question demands it (e.g., a PR number).
- nice_to_have: add synonyms or related terms that could help retrieval.

User question: <<<{{USER_Q}}>>>
`;

type Hit = {
  id: string;
  score: number;
  metadata: any;
};

async function callLLM(AI: Ai, system: string, user: string) {
  const model = "@cf/meta/llama-3.1-8b-instruct";
  const res = await AI.run(model as any, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  // normalize response
  const text =
    (res as any).response ?? (res as any).result ?? JSON.stringify(res);
  return text;
}

function compactHit(h: any) {
  const m = h.metadata || {};
  return {
    id: h.id,
    score: h.score,
    source_type: m.source_type,
    source_id: m.source_id,
    title: m.title,
    summary: m.summary,
    decisions: m.decisions,
    actions: m.actions,
    tags: m.tags,
    entities: m.entities,
    files: m.files,
    commits: m.commits,
    review_state: m.review_state,
    state: m.state,
    time_start: m.time_start,
    time_end: m.time_end,
    merged_at: m.merged_at,
  };
}

export async function handleAsk(request: Request, env: Env) {
  const { q, k = 40 } = await request.json();

  // 1) Parse intent with LLM
  const intentJson = await callLLM(
    env.AI!,
    "You produce strict JSON for intent extraction. No commentary.",
    `Fill the intent schema for this question:\n${q}`
  );
  let intent: Intent;
  try {
    intent = JSON.parse(intentJson);
  } catch {
    intent = {
      query: q,
      question_type: "other",
      topic_terms: [],
      include_sources: ["meeting", "pr"],
    };
  }

  // 2) Vector search on the natural query (embed user question)
  const queryVec = await embedWithWorkersAI(env.AI!, intent.query);
  // @ts-ignore
  const raw = await env.VECTORIZE.query(queryVec, {
    topK: k,
    returnValues: false,
  });

  // 3) (Optional) light filter by source_type if intent specifies
  let matches: Hit[] = (raw.matches ?? []).map((m: any) => ({
    id: m.id,
    score: m.score,
    metadata: m.metadata || {},
  }));
  if (intent.include_sources?.length) {
    const allow = new Set(intent.include_sources);
    matches = matches.filter((h) => allow.has(h.metadata.source_type));
  }

  // 4) Build a compact context for the LLM to reason over (keep payload tight)
  const context = matches.slice(0, k).map(compactHit);

  // 5) Ask the LLM to:
  //   - cluster hits into subjects,
  //   - answer the user's question,
  //   - cite member IDs as evidence
  const reasoningPrompt = `
  You are a retrieval reasoning agent. You receive:
  - A user question
  - A list of retrieved "segment" hits (meetings + PRs) with metadata
  
  Tasks:
  1) Cluster the hits into coherent SUBJECTS (combine meetings and PRs that discuss the same thing).
  2) Answer the question concisely. If the question is "when", pick the most defensible date:
     - Prefer merged PR date (merged_at) whose title/summary/entities match the topic.
     - Else earliest meeting time_start where decisions/actions indicate introduction/enable/launch.
     - Else earliest timestamp among the cluster.
  3) Provide a short reasoning note and cite evidence by IDs.
  
  Output JSON ONLY:
  {
    "answer": "string",
    "subjects": [
      {
        "label": "string",       // your best short name for the subject
        "members": ["seg_id", ...],
        "evidence": ["seg_id", ...],
        "intro_date": "ISO or null",
        "notes": "string"
      }
    ]
  }
  
  User question: """${q}"""
  Topic hints: ${JSON.stringify({
    question_type: intent.question_type,
    topic_terms: intent.topic_terms,
  })}
  Retrieved hits (JSON array):
  ${JSON.stringify(context)}
    `.trim();

  const llmOutText = await callLLM(
    env.AI!,
    "Return valid JSON only. No Markdown.",
    reasoningPrompt
  );
  let llmOut: any;
  try {
    llmOut = JSON.parse(llmOutText);
  } catch {
    llmOut = { answer: "", subjects: [] };
  }

  return new Response(
    JSON.stringify(
      {
        intent,
        answer: llmOut.answer ?? "",
        subjects: llmOut.subjects ?? [],
        hits_considered: context.length,
      },
      null,
      2
    ),
    { headers: { "content-type": "application/json" } }
  );
}
