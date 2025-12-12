import type {
  MomentDescription,
  MicroMomentDescription,
} from "../types";
import type { MicroMoment } from "../momentDb";
import { callLLM } from "../utils/llm";

export async function synthesizeMicroMoments(
  microMoments: MicroMoment[]
): Promise<
  Array<MomentDescription & { summary: string; microPaths: string[] }>
> {
  if (microMoments.length === 0) {
    return [];
  }

  const formattedMoments = microMoments
    .map(
      (moment, idx) =>
        `Index: ${idx + 1}\nPath: ${moment.path}\nSummary: ${
          moment.summary || "No summary"
        }\n`
    )
    .join("\n---\n\n");

  const synthesisPrompt = `You are an expert at analyzing sequences of events to build a coherent narrative. Your task is to consolidate a series of low-level "micro-moments" into a smaller number of high-level "macro-moments" that tell a story of progress, discovery, and decision-making.

**Your Goal:** Identify and record the most significant events. Specifically look for turning points, key discoveries or realizations, newly identified problems, new insights, important decisions, changes in approach, new attempts at solving the problem

**Output format (strictly follow this):**

MACRO-MOMENT 1
TITLE: A concise, past-tense title for the event (e.g., "Realized barrel files were needed for tree-shaking")
INDICES: A comma-separated list of the Index values (1-based) that belong to this macro-moment, in chronological order
SUMMARY: 2-4 sentences explaining what happened, why it was a significant turning point or decision, and what its impact was on the project.

MACRO-MOMENT 2
TITLE: A concise, past-tense title for the event
INDICES: A comma-separated list of the Index values (1-based) that belong to this macro-moment, in chronological order
SUMMARY: 2-4 sentences explaining what happened, why it was a significant turning point or decision, and what its impact was on the project.

**Input micro-moments:**
${formattedMoments}

**Your response must:**
- Begin with "MACRO-MOMENT 1"
- Contain only the formatted blocks.
- Every INDICES entry must reference only Index values present in the input (1 to ${microMoments.length}).
- Focus on the story of the work, not just a chronological list.`;

  try {
    const response = await callLLM(synthesisPrompt, "slow-reasoning", {
      temperature: 0.3,
      max_tokens: 2000,
      reasoning: {
        effort: "low",
      },
    });

    const momentRegex =
      /MACRO-MOMENT \d+\s*TITLE:\s*(.*?)\s*INDICES:\s*(.*?)\s*SUMMARY:\s*([\s\S]*?)(?=\s*MACRO-MOMENT \d+|$)/g;

    const macroMoments: Array<
      MomentDescription & { summary: string; microPaths: string[] }
    > = [];

    let match;
    while ((match = momentRegex.exec(response)) !== null) {
      const [, title, indicesRaw, summary] = match;
      if (!title || !summary) {
        continue;
      }

      const parsedIndices = String(indicesRaw || "")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n >= 1 && n <= microMoments.length);

      const uniqueIndices = Array.from(new Set(parsedIndices)).sort(
        (a, b) => a - b
      );

      if (uniqueIndices.length === 0) {
        continue;
      }

      const members = uniqueIndices.map((idx) => microMoments[idx - 1]).filter(Boolean) as MicroMoment[];

      const microPaths = members.map((m) => m.path);

      const content = members
        .map((m) => m.content)
        .filter(Boolean)
        .join("\n\n---\n\n");

      macroMoments.push({
        title: title.trim(),
        summary: summary.trim(),
        microPaths,
        content: content || "",
        author: members[0]?.author || "unknown",
        createdAt: members[0]?.createdAt || new Date().toISOString(),
        sourceMetadata: members[0]?.sourceMetadata,
      });
    }

    if (macroMoments.length === 0) {
      console.error(
        `[engine] Failed to parse any macro-moments from response. Full response:\n${response}`
      );
      return [
        {
          title: "Summarized micro-moments",
          summary: "Synthesized macro-moments could not be parsed.",
          microPaths: microMoments.map((m) => m.path),
          content: microMoments
            .map((m) => m.content)
            .filter(Boolean)
            .join("\n\n---\n\n"),
          author: microMoments[0]?.author || "unknown",
          createdAt: microMoments[0]?.createdAt || new Date().toISOString(),
          sourceMetadata: microMoments[0]?.sourceMetadata,
        },
      ];
    }

    return macroMoments;
  } catch (error) {
    console.error(
      `[engine] Error during synthesis:`,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

