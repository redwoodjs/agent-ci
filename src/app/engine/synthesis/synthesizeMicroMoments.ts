import type { MomentDescription, MicroMomentDescription } from "../types";
import type { MicroMoment } from "../momentDb";
import { callLLM } from "../utils/llm";

export async function synthesizeMicroMoments(
  microMoments: MicroMoment[],
  options?: {
    macroSynthesisPromptContext?: string | null;
  }
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

  const macroSynthesisPromptContext = options?.macroSynthesisPromptContext;

  const titleLabel =
    typeof macroSynthesisPromptContext === "string"
      ? macroSynthesisPromptContext.match(
          /^\s*-\s*title_label:\s*(.+)\s*$/m
        )?.[1]
      : undefined;
  const summaryDescriptor =
    typeof macroSynthesisPromptContext === "string"
      ? macroSynthesisPromptContext.match(
          /^\s*-\s*summary_descriptor:\s*(.+)\s*$/m
        )?.[1]
      : undefined;
  const documentRef =
    typeof macroSynthesisPromptContext === "string"
      ? macroSynthesisPromptContext.match(
          /^\s*-\s*document_ref:\s*([^\s]+)\s*$/m
        )?.[1]
      : undefined;

  const formattingRules = `Formatting rules:
- If the "Source formatting and reference context" section includes a line "title_label: ...", TITLE must begin with the exact value after "title_label: " (character-for-character).
- If the "Source formatting and reference context" section includes a line "summary_descriptor: ...", SUMMARY must begin with the exact value after "summary_descriptor: " (character-for-character).
- If the "Source formatting and reference context" section includes a line "document_ref: <token>", SUMMARY must include "[<token>]" exactly once (example: "[github:issue/redwoodjs/sdk/552]").
- Summary must include a canonical reference token in brackets near the first mention of the primary entity when applicable.
- Canonical token format: source:document_type/path
- Examples:
  - github:issue/redwoodjs/sdk/552
  - github:pr/redwoodjs/sdk/530
  - github:issue_comment/redwoodjs/sdk/552/1234567890
  - github:pr_comment/redwoodjs/sdk/530/1234567890
  - discord:thread/<guildid>/<channelid>/<threadid>
  - discord:thread_message/<guildid>/<channelid>/<threadid>/<messageid>
`;

  const resolvedRequirements =
    titleLabel || summaryDescriptor || documentRef
      ? `Resolved requirements for this document:
- required_title_prefix: ${titleLabel ?? "(none)"}
- required_summary_prefix: ${summaryDescriptor ?? "(none)"}
- required_document_ref_token: ${documentRef ?? "(none)"}
- If required_document_ref_token is not "(none)", SUMMARY must contain it in brackets exactly once: [${
          documentRef ?? ""
        }]
`
      : "";

  const synthesisPrompt = `You are an expert at analyzing sequences of events to build a coherent narrative. Your task is to consolidate a series of low-level "micro-moments" into a smaller number of high-level "macro-moments" that tell a story of progress, discovery, and decision-making.

**Your Goal:** Identify and record the most significant events. Specifically look for turning points, key discoveries or realizations, newly identified problems, new insights, important decisions, changes in approach, new attempts at solving the problem

${formattingRules}

${resolvedRequirements}

${
  macroSynthesisPromptContext
    ? `Source formatting and reference context:\n${macroSynthesisPromptContext}\n`
    : ""
}

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
- Every INDICES entry must reference only Index values present in the input (1 to ${
    microMoments.length
  }).
- Focus on the story of the work, not just a chronological list.`;

  try {
    const response = await callLLM(synthesisPrompt, "slow-reasoning", {
      temperature: 0,
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

      const members = uniqueIndices
        .map((idx) => microMoments[idx - 1])
        .filter(Boolean) as MicroMoment[];

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
