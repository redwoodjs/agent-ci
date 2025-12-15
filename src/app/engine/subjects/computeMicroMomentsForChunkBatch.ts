import type { Chunk } from "../types";
import { callLLM } from "../utils/llm";

export async function computeMicroMomentsForChunkBatch(
  chunks: Chunk[],
  options: {
    promptContext: string;
  }
): Promise<string[] | null> {
  if (chunks.length === 0) {
    return [];
  }

  const chunkText = chunks
    .map((chunk, i) => {
      const content = chunk.content ?? "";
      const type = (chunk.metadata as any)?.type ?? "unknown";
      const authorRaw = (chunk.metadata as any)?.author;
      const author =
        typeof authorRaw === "string" && authorRaw.trim().length > 0
          ? authorRaw.trim()
          : "unknown";
      return `CHUNK ${i + 1} (type=${type}, author=${author}):\n${content}`;
    })
    .join("\n\n---\n\n");

  const prompt =
    `You will be given a small batch of ordered chunks from a single document.\n` +
    options.promptContext +
    `Return a list of short summaries of what was discussed or established.\n\n` +
    `Rules:\n` +
    `- Output must be plain text.\n` +
    `- No prose, no markdown, no code fences.\n` +
    `- Output must be lines in this format: S<index>|<summary>\n` +
    `- Indices start at 1 and must be sequential with no gaps.\n` +
    `- Each summary must be 1-3 sentences.\n` +
    `- Each summary must be <= 400 characters.\n` +
    `- Include concrete terms (names, ids, file paths, errors, decisions) when present.\n` +
    `- Each summary should explicitly attribute key statements to the relevant person.\n` +
    `  - Prefer the author shown in the CHUNK header (author=...).\n` +
    `  - If a different person is explicitly mentioned in the content (e.g. quoted), attribute to that person.\n` +
    `  - Example: "@peter suggested ...", "Peter noted ...", "@alice proposed ...".\n` +
    `- Do not include phrases like "Content about".\n` +
    `- Do not output meta commentary about summarizing.\n` +
    `- Return between 1 and 12 items.\n\n` +
    `CHUNKS:\n${chunkText}\n\n` +
    `OUTPUT:`;

  try {
    const response = await callLLM(prompt, "slow-reasoning", {
      temperature: 0,
      max_tokens: 1200,
      reasoning: {
        effort: "low",
        summary: "concise",
      },
    });

    return parseMicroMomentLines(response);
  } catch (error) {
    console.error(
      `[engine] Failed to compute micro moments from chunk batch:`,
      error
    );
    return null;
  }
}

function parseMicroMomentLines(response: string): string[] | null {
  const rawLines = response
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith("```"));

  const byIndex = new Map<number, string>();
  for (const line of rawLines) {
    const pipeIdx = line.indexOf("|");
    if (pipeIdx < 0) {
      continue;
    }

    let left = line.slice(0, pipeIdx).trim();
    if (left.startsWith("S")) {
      left = left.slice(1).trim();
    }

    const idx = Number.parseInt(left, 10);
    if (!Number.isFinite(idx) || idx < 1) {
      continue;
    }

    const body = line
      .slice(pipeIdx + 1)
      .trim()
      .replaceAll("\t", " ")
      .split(/\s+/)
      .join(" ");

    if (!body) {
      continue;
    }
    if (body.toLowerCase().startsWith("content about:")) {
      return null;
    }

    byIndex.set(idx, body);
  }

  const out: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const body = byIndex.get(i);
    if (!body) {
      break;
    }
    out.push(body);
  }

  return out.length > 0 ? out : null;
}
