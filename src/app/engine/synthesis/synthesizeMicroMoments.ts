import type { MomentDescription, MicroMomentDescription } from "../types";
import type { MicroMoment } from "../databases/momentGraph";
import { callLLM } from "../utils/llm";

export type MacroMoment = MomentDescription & {
  summary: string;
  microPaths: string[];
  importance?: number;
};

export type MacroMomentStream = {
  streamId: string;
  macroMoments: MacroMoment[];
};

export type SynthesisAuditEvent = {
  kind:
    | "macro-synthesis-parse-failure"
    | "macro-synthesis-error"
    | "macro-synthesis-success"
    | "macro-stream-synthesis-success"
    | "macro-stream-synthesis-error";
  message: string;
  promptHash16: string | null;
  responsePreview: string | null;
  responseLength: number | null;
};

async function hashText16(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex.slice(0, 16);
}

function safePreview(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

export async function synthesizeMicroMoments(
  microMoments: MicroMoment[],
  options?: {
    macroSynthesisPromptContext?: string | null;
    auditSink?: (event: SynthesisAuditEvent) => void;
    logger?: (message: string, data?: any) => void;
  }
): Promise<
  Array<
    MomentDescription & {
      summary: string;
      microPaths: string[];
      importance?: number;
    }
  >
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
- If the "Source formatting and reference context" section includes a line "document_ref: <token>", SUMMARY must include "[<token>]" exactly once (example: "[mchn://gh/issue/redwoodjs/sdk/552]").
- Summary must include a canonical reference token in brackets near the first mention of the primary entity when applicable.
- Canonical token format: mchn://<source>/<type>/<path>
- Examples:
  - mchn://gh/issue/redwoodjs/sdk/552
  - mchn://gh/pr/redwoodjs/sdk/530
  - mchn://gh/issue_comment/redwoodjs/sdk/552/1234567890
  - mchn://gh/pr_comment/redwoodjs/sdk/530/1234567890
  - mchn://dc/thread/<guildid>/<channelid>/<threadid>
  - mchn://dc/thread_message/<guildid>/<channelid>/<threadid>/<messageid>
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

  const synthesisPrompt = `You are an expert at analyzing sequences of events to build a coherent narrative. Your task is to consolidate a series of low-level "micro-moments" into a smaller number of high-level "macro-moments" that summarize the turning points in the work timeline.

Selection rules (macro moments to exclude):
- Do not emit macro moments for automated system or bot status updates (examples: deployment previews, CI status, preview builds, dependency bot updates) unless they contain a concrete decision or a change in technical direction.
- Do not emit macro moments for administrative state changes (examples: closing an issue, adding labels, assigning reviewers) unless the text includes a concrete technical decision or an implementation change.
- Do not emit macro moments for social chatter, jokes, greetings, reactions, emojis, memes, gifs, or off-topic banter.
- Do not emit macro moments for generic encouragement, praise, or gratitude.

Selection rules (macro moments to include):
- Emit a macro moment only when it contains at least one of:
  - a problem or challenge
  - an opportunity or initiative
  - an attempt at a solution (including experiments and investigations)
  - a decision
  - a solution (prefer describing a merged pull request as a solution; treat local work or unmerged work as an attempt)
- Omit all other content (do not generate a low-signal macro moment).
- Prefer macro moments that contain concrete anchors (examples: error messages, commands, PR/issue links, canonical reference tokens).

${formattingRules}

${resolvedRequirements}

${
  macroSynthesisPromptContext
    ? `Source formatting and reference context:\n${macroSynthesisPromptContext}\n`
    : ""
}

**Output format (strictly follow this):**

MACRO-MOMENT 1
TITLE: <required_title_prefix> <concise, past-tense title for the event>
INDICES: A comma-separated list of the Index values (1-based) that belong to this macro-moment, in chronological order
IMPORTANCE: A number from 0 to 1 (inclusive). 0 means not important. 1 means very important. Use increments of 0.05.
SUMMARY: <required_summary_prefix> 2-4 sentences explaining what happened, why it was a significant turning point or decision, and what its impact was on the project. Include the required document ref token if provided.

MACRO-MOMENT 2
TITLE: <required_title_prefix> <concise, past-tense title for the event>
INDICES: A comma-separated list of the Index values (1-based) that belong to this macro-moment, in chronological order
IMPORTANCE: A number from 0 to 1 (inclusive). 0 means not important. 1 means very important. Use increments of 0.05.
SUMMARY: <required_summary_prefix> 2-4 sentences explaining what happened, why it was a significant turning point or decision, and what its impact was on the project. Include the required document ref token if provided.

**Input micro-moments:**
${formattedMoments}

**Your response must:**
- Begin with "MACRO-MOMENT 1".
- Contain only the formatted blocks.
- Every INDICES entry must reference only Index values present in the input (1 to ${
    microMoments.length
  }).
- Focus on the story of the work, not just a chronological list.`;

  const promptHash16 =
    typeof synthesisPrompt === "string" && synthesisPrompt.length > 0
      ? await hashText16(synthesisPrompt)
      : null;

  try {
    const response = await callLLM(synthesisPrompt, "slow-reasoning", {
      temperature: 0,
      max_tokens: 4000,
      reasoning: {
        effort: "low",
      },
      logger: options?.logger,
    });

    const momentRegex =
      /MACRO-MOMENT \d+\s*TITLE:\s*(.*?)\s*INDICES:\s*(.*?)\s*IMPORTANCE:\s*(.*?)\s*SUMMARY:\s*([\s\S]*?)(?=\s*MACRO-MOMENT \d+|$)/g;

    const macroMoments: Array<
      MomentDescription & {
        summary: string;
        microPaths: string[];
        importance?: number;
      }
    > = [];

    function clampImportance(value: unknown): number | undefined {
      const raw = typeof value === "string" ? value.trim() : "";
      if (!raw) {
        return undefined;
      }
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed)) {
        return undefined;
      }
      if (parsed < 0) {
        return 0;
      }
      if (parsed > 1) {
        return 1;
      }
      return parsed;
    }

    let match;
    while ((match = momentRegex.exec(response)) !== null) {
      const [, title, indicesRaw, importanceRaw, summary] = match;
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

      const memberTimes = members
        .map((m) => Date.parse(m.createdAt))
        .filter((ms) => Number.isFinite(ms));
      const minMs =
        memberTimes.length > 0 ? Math.min(...memberTimes) : Date.now();
      const maxMs = memberTimes.length > 0 ? Math.max(...memberTimes) : minMs;
      const timeRange =
        memberTimes.length > 0
          ? {
              start: new Date(minMs).toISOString(),
              end: new Date(maxMs).toISOString(),
            }
          : null;

      const microPaths = members.map((m) => m.path);

      const content = members
        .map((m) => m.content)
        .filter(Boolean)
        .join("\n\n---\n\n");

      const baseSourceMetadata = members[0]?.sourceMetadata;
      const sourceMetadata =
        timeRange &&
        baseSourceMetadata &&
        typeof baseSourceMetadata === "object"
          ? { ...(baseSourceMetadata as any), timeRange }
          : timeRange
          ? { timeRange }
          : baseSourceMetadata;

      macroMoments.push({
        title: title.trim(),
        summary: summary.trim(),
        importance: clampImportance(importanceRaw),
        microPaths,
        content: content || "",
        author: members[0]?.author || "unknown",
        createdAt: new Date(minMs).toISOString(),
        sourceMetadata,
      });
    }

    if (macroMoments.length === 0) {
      console.error(
        `[engine] Failed to parse any macro-moments from response. Full response:\n${response}`
      );
      options?.auditSink?.({
        kind: "macro-synthesis-parse-failure",
        message: "Failed to parse any macro moments from synthesis response.",
        promptHash16,
        responsePreview: safePreview(response, 2000),
        responseLength: typeof response === "string" ? response.length : null,
      });
      return [];
    }

    options?.auditSink?.({
      kind: "macro-synthesis-success",
      message: `Parsed ${macroMoments.length} macro moments.`,
      promptHash16,
      responsePreview: safePreview(response, 2000),
      responseLength: typeof response === "string" ? response.length : null,
    });

    return macroMoments;
  } catch (error) {
    console.error(
      `[engine] Error during synthesis:`,
      error instanceof Error ? error.message : String(error)
    );
    options?.auditSink?.({
      kind: "macro-synthesis-error",
      message: error instanceof Error ? error.message : String(error),
      promptHash16: null,
      responsePreview: null,
      responseLength: null,
    });
    return [];
  }
}

export async function synthesizeMicroMomentsIntoStreams(
  microMoments: MicroMoment[],
  options?: {
    macroSynthesisPromptContext?: string | null;
    auditSink?: (event: SynthesisAuditEvent) => void;
    logger?: (message: string, data?: any) => void;
  }
): Promise<MacroMomentStream[]> {
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
- If the "Source formatting and reference context" section includes a line "document_ref: <token>", SUMMARY must include "[<token>]" exactly once (example: "[mchn://gh/issue/redwoodjs/sdk/552]").
- Summary must include a canonical reference token in brackets near the first mention of the primary entity when applicable.
- Canonical token format: mchn://<source>/<type>/<path>
- Examples:
  - mchn://gh/issue/redwoodjs/sdk/552
  - mchn://gh/pr/redwoodjs/sdk/530
  - mchn://gh/issue_comment/redwoodjs/sdk/552/1234567890
  - mchn://gh/pr_comment/redwoodjs/sdk/530/1234567890
  - mchn://dc/thread/<guildid>/<channelid>/<threadid>
  - mchn://dc/thread_message/<guildid>/<channelid>/<threadid>/<messageid>
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

  const synthesisPrompt = `You are an expert at analyzing sequences of events to build a coherent narrative.
Your task is to separate the micro-moments into multiple independent streams of thought, and then synthesize macro-moments within each stream.

Goal:
- A stream should be coherent (one topic/work item/problem) across its macro-moments.
- Do not assume the entire document is one subject.
- Do not merge unrelated topics into one stream.
- Macro moments are for turning points in the work timeline, not a chronological transcript.
- Prefer emitting fewer macro moments over emitting low-signal macro moments.

Selection rules (macro moments to exclude):
- Do not emit macro moments for automated system or bot status updates (examples: deployment previews, CI status, preview builds, dependency bot updates) unless they contain a concrete decision or a change in technical direction.
- Do not emit macro moments for administrative state changes (examples: closing an issue, adding labels, assigning reviewers) unless the text includes a concrete technical decision or an implementation change.
- Do not emit macro moments for social chatter, jokes, greetings, reactions, emojis, memes, gifs, or off-topic banter.
- Do not emit macro moments for administrative or status updates (examples: "back now", "will continue later", "checking something", "pairing now") unless they significantly change the technical direction of the work.
- Do not emit macro moments for generic encouragement or gratitude.
- Do not emit macro moments for minor UI tweaks (examples: margin/padding adjustments, color changes, typo fixes in UI text) unless they are part of a larger structural initiative.
- Do not emit macro moments for trivial content maintenance (examples: small README fix, copyright date update) that does not represent a work milestone.

Selection rules (macro moments to include):
- Emit a macro moment only when it contains at least one of:
  - a problem or challenge
  - an opportunity or initiative
  - an attempt at a solution (including experiments and investigations)
  - a decision
  - a solution (prefer describing a merged pull request as a solution; treat local work or unmerged work as an attempt)
- Omit all other content (do not generate a low-signal macro moment).
- Prefer macro moments that contain concrete anchors (examples: error messages, commands, PR/issue links, canonical reference tokens).

${formattingRules}

${resolvedRequirements}

${
  macroSynthesisPromptContext
    ? `Source formatting and reference context:\n${macroSynthesisPromptContext}\n`
    : ""
}

Output format (strictly follow this):

STREAM 1
MACRO-MOMENT 1
TITLE: <required_title_prefix> <concise, past-tense title for the event>
INDICES: A comma-separated list of the Index values (1-based) that belong to this macro-moment, in chronological order
IMPORTANCE: A number from 0 to 1 (inclusive). 0 means not important. 1 means very important. Use increments of 0.05.
SUMMARY: <required_summary_prefix> 2-4 sentences explaining what happened. Include the required document ref token if provided.

MACRO-MOMENT 2
...

STREAM 2
MACRO-MOMENT 1
...

Your response must:
- Begin with "STREAM 1".
- Contain only STREAM blocks and MACRO-MOMENT blocks.
- Every INDICES entry must reference only Index values present in the input (1 to ${
    microMoments.length
  }).
- Each Index value should appear in at most one MACRO-MOMENT across the entire response.
- Within each stream, macro moments must be in chronological order.
- It is allowed to omit low-signal micro-moments entirely (their Index values do not need to appear in any MACRO-MOMENT).

Input micro-moments:
${formattedMoments}
`;

  function clampImportance(value: unknown): number | undefined {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) {
      return undefined;
    }
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    if (parsed < 0) {
      return 0;
    }
    if (parsed > 1) {
      return 1;
    }
    return parsed;
  }

  const momentRegex =
    /MACRO-MOMENT \d+\s*TITLE:\s*(.*?)\s*INDICES:\s*(.*?)\s*IMPORTANCE:\s*(.*?)\s*SUMMARY:\s*([\s\S]*?)(?=\s*MACRO-MOMENT \d+|\s*$)/g;
  const streamRegex = /STREAM\s+(\d+)\s*([\s\S]*?)(?=\n\s*STREAM\s+\d+\s*|$)/g;

  const promptHash16 =
    typeof synthesisPrompt === "string" && synthesisPrompt.length > 0
      ? await hashText16(synthesisPrompt)
      : null;

  try {
    const response = await callLLM(synthesisPrompt, "slow-reasoning", {
      temperature: 0,
      max_tokens: 4000,
      logger: options?.logger,
    });

    const streams: MacroMomentStream[] = [];
    const usedIndices = new Set<number>();

    let sm;
    while ((sm = streamRegex.exec(response)) !== null) {
      const streamNumber = sm[1];
      const streamBody = sm[2] ?? "";
      const streamId = `stream-${streamNumber}`;

      const macroMoments: MacroMoment[] = [];
      momentRegex.lastIndex = 0;
      let match;
      while ((match = momentRegex.exec(streamBody)) !== null) {
        const [, title, indicesRaw, importanceRaw, summary] = match;
        if (!title || !summary) {
          continue;
        }

        const parsedIndices = String(indicesRaw || "")
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n) && n >= 1 && n <= microMoments.length)
          .filter((n) => !usedIndices.has(n));

        const uniqueIndices = Array.from(new Set(parsedIndices)).sort(
          (a, b) => a - b
        );

        if (uniqueIndices.length === 0) {
          continue;
        }

        for (const idx of uniqueIndices) {
          usedIndices.add(idx);
        }

        const members = uniqueIndices
          .map((idx) => microMoments[idx - 1])
          .filter(Boolean) as MicroMoment[];

        const memberTimes = members
          .map((m) => Date.parse(m.createdAt))
          .filter((ms) => Number.isFinite(ms));
        const minMs =
          memberTimes.length > 0 ? Math.min(...memberTimes) : Date.now();
        const maxMs = memberTimes.length > 0 ? Math.max(...memberTimes) : minMs;
        const timeRange =
          memberTimes.length > 0
            ? {
                start: new Date(minMs).toISOString(),
                end: new Date(maxMs).toISOString(),
              }
            : null;

        const microPaths = members.map((m) => m.path);
        const content = members
          .map((m) => m.content)
          .filter(Boolean)
          .join("\n\n---\n\n");

        const baseSourceMetadata = members[0]?.sourceMetadata;
        const sourceMetadata =
          timeRange &&
          baseSourceMetadata &&
          typeof baseSourceMetadata === "object"
            ? { ...(baseSourceMetadata as any), timeRange, streamId }
            : timeRange
            ? { timeRange, streamId }
            : baseSourceMetadata
            ? { ...(baseSourceMetadata as any), streamId }
            : { streamId };

        macroMoments.push({
          title: title.trim(),
          summary: summary.trim(),
          importance: clampImportance(importanceRaw),
          microPaths,
          content: content || "",
          author: members[0]?.author || "unknown",
          createdAt: new Date(minMs).toISOString(),
          sourceMetadata,
        });
      }

      if (macroMoments.length > 0) {
        streams.push({ streamId, macroMoments });
      }
    }

    if (streams.length === 0) {
      const single = await synthesizeMicroMoments(microMoments, options);
      return single.length > 0
        ? [{ streamId: "stream-1", macroMoments: single }]
        : [];
    }

    options?.auditSink?.({
      kind: "macro-stream-synthesis-success",
      message: `Parsed ${streams.length} streams.`,
      promptHash16,
      responsePreview: safePreview(response, 2000),
      responseLength: typeof response === "string" ? response.length : null,
    });

    return streams;
  } catch (error) {
    console.error(
      `[engine] Error during stream synthesis:`,
      error instanceof Error ? error.message : String(error)
    );
    options?.auditSink?.({
      kind: "macro-stream-synthesis-error",
      message: error instanceof Error ? error.message : String(error),
      promptHash16,
      responsePreview: null,
      responseLength: null,
    });
    return [];
  }
}
