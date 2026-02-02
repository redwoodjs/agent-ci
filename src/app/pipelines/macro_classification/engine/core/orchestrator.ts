import type { MacroMomentDescription, Document } from "../../../../engine/types";
import { PipelineContext } from "../../../../engine/runtime/types";
import { callLLM } from "../../../../engine/utils/llm";

export type MacroGatingConfig = {
  macroMaxPerStream: number;
  macroMinImportance: number;
  noisePatternStringsFromEnv: string[];
  discordNoisePatternStringsFromEnv: string[];
};

export function gateMacroMoments(
  macroMomentDescriptionsRaw: MacroMomentDescription[],
  config: MacroGatingConfig
): {
  macroMomentDescriptions: MacroMomentDescription[];
  gatingAudit: {
    inputMacroCount: number;
    outputMacroCount: number;
    noiseDroppedCount: number;
    noiseDroppedTitlesSample?: string[] | null;
  };
} {
  const noisePatternStrings = [
    "\\bdependabot\\b",
    "\\bdeployment preview\\b",
    "\\bpreview deployment\\b",
    "\\bcloudflare pages\\b",
    "\\b(successful deployment|deployed successfully)\\b",
    ...(config.noisePatternStringsFromEnv ?? []),
  ];

  const noiseRegexes = noisePatternStrings
    .map((p) => {
      try {
        return new RegExp(p, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean) as RegExp[];

  const discordNoisePatternStrings = [
    "\\bafk\\b",
    "\\bbrb\\b",
    "\\bback\\s+now\\b",
    "\\bapologiz(e|ed|ing)\\b",
    "\\bsync\\b",
    "\\bpair(ing)?\\b",
    "\\btour\\b",
    "\\bmeeting\\b",
    "\\bcall\\b",
    "\\btimezone\\b",
    "\\bschedul(e|ed|ing)\\b",
    ...(config.discordNoisePatternStringsFromEnv ?? []),
  ];

  const discordNoiseRegexes = discordNoisePatternStrings
    .map((p) => {
      try {
        return new RegExp(p, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean) as RegExp[];

  function hasTechnicalAnchors(text: string): boolean {
    if (!text) return false;
    if (text.includes("mchn://gh/")) return true;
    if (text.includes("```")) return true;
    if (/\b(error|exception|stack trace|traceback)\b/i.test(text)) return true;
    if (
      /\b(fix|fixed|bug|regression|implement|implemented|add|added|remove|removed|merge|merged)\b/i.test(
        text
      )
    ) {
      return true;
    }
    return false;
  }

  function isNoiseMacroMoment(m: MacroMomentDescription): boolean {
    const title = typeof (m as any)?.title === "string" ? (m as any).title : "";
    const summary = typeof (m as any)?.summary === "string" ? (m as any).summary : "";
    const author = typeof (m as any)?.author === "string" ? (m as any).author : "";

    if (
      title.trim() === "Summarized micro-moments" &&
      summary.trim() === "Synthesized macro-moments could not be parsed."
    ) {
      return true;
    }

    const combinedLower = `${title}\n${summary}`.toLowerCase();
    const isGitHub = combinedLower.includes("mchn://gh/");
    const isDiscord =
      combinedLower.includes("mchn://dc/") ||
      title.trim().toLowerCase().startsWith("[discord");

    if (isDiscord) {
      const combined = `${title}\n${summary}`;
      if (hasTechnicalAnchors(combined)) return false;
      for (const re of discordNoiseRegexes) {
        if (re.test(title) || re.test(summary)) return true;
      }
      return false;
    }

    if (!isGitHub) return false;

    const authorLower = author.toLowerCase();
    if (
      authorLower.includes("dependabot") ||
      authorLower.includes("[bot]") ||
      authorLower.endsWith("-bot") ||
      authorLower.endsWith(" bot") ||
      authorLower.includes(" bot ")
    ) {
      return true;
    }

    const strippedTitleLower = title
      .replace(/^\s*\[[^\]]+\]\s*/g, "")
      .trim()
      .toLowerCase();

    if (
      strippedTitleLower.startsWith("praise") ||
      strippedTitleLower.startsWith("thanks") ||
      strippedTitleLower.startsWith("thank you") ||
      strippedTitleLower.startsWith("kudos")
    ) {
      return true;
    }

    for (const re of noiseRegexes) {
      if (re.test(title) || re.test(summary)) return true;
    }

    if (combinedLower.includes("closed issue")) {
      const hasTechnicalSignal =
        /\b(fix|fixed|bug|error|investigat|regression|implement|implemented|add|added|remove|removed|merge|merged|release|released|ship|shipped|deploy|deployed|rollback)\b/i.test(
          `${title}\n${summary}`
        );
      if (!hasTechnicalSignal) return true;
    }

    return false;
  }

  const withIndex = macroMomentDescriptionsRaw
    .map((m, idx) => ({
      idx,
      m,
      importance: typeof (m as any).importance === "number" ? (m as any).importance : 0,
    }))
    .filter((x) => !isNoiseMacroMoment(x.m));

  if (withIndex.length === 0) {
    return {
      macroMomentDescriptions: [],
      gatingAudit: {
        inputMacroCount: macroMomentDescriptionsRaw.length,
        outputMacroCount: 0,
        noiseDroppedCount: macroMomentDescriptionsRaw.length,
        noiseDroppedTitlesSample: macroMomentDescriptionsRaw
          .slice(0, 20)
          .map((m) => (typeof (m as any)?.title === "string" ? (m as any).title : null))
          .filter((t): t is string => !!t),
      },
    };
  }

  const sortedByImportance = [...withIndex].sort((a, b) => b.importance - a.importance || a.idx - b.idx);
  const max = config.macroMaxPerStream || 12;
  const capped = sortedByImportance.slice(0, max);
  const cappedSortedByIndex = [...capped].sort((a, b) => a.idx - b.idx);

  const filtered = cappedSortedByIndex.filter((x) => x.importance >= (config.macroMinImportance || 0));

  if (filtered.length > 0) {
    return {
      macroMomentDescriptions: filtered.map((x) => x.m),
      gatingAudit: {
        inputMacroCount: macroMomentDescriptionsRaw.length,
        outputMacroCount: filtered.length,
        noiseDroppedCount: macroMomentDescriptionsRaw.length - withIndex.length,
      },
    };
  }

  const fallback = cappedSortedByIndex[0] ?? sortedByImportance[0];
  return {
    macroMomentDescriptions: fallback ? [fallback.m] : [],
    gatingAudit: {
      inputMacroCount: macroMomentDescriptionsRaw.length,
      outputMacroCount: fallback ? 1 : 0,
      noiseDroppedCount: macroMomentDescriptionsRaw.length - withIndex.length,
    },
  };
}

export async function classifyMacroMoments(input: {
  documentId: string;
  macroMoments: MacroMomentDescription[];
  context: PipelineContext;
}): Promise<{
  macroMoments: MacroMomentDescription[];
  classifications: any[] | null;
}> {
  if (input.macroMoments.length === 0) {
    return { macroMoments: [], classifications: [] };
  }

  const momentsText = input.macroMoments
    .map((m, idx) => `Index: ${idx + 1}\nTitle: ${m.title || ""}\nSummary: ${m.summary || ""}\n`)
    .join("\n---\n\n");

  const prompt = `You are classifying macro moments in a timeline.

For each macro moment, output:
- momentKind: one of "problem", "challenge", "opportunity", "initiative", "attempt", "decision", "solution"
- isSubject: true only when momentKind is one of the topic demarcation kinds (problem/challenge/opportunity/initiative)
- subjectKind: when isSubject is true, this must be the same as momentKind
- subjectReason: when isSubject is true, 1-2 sentences explaining why this starts a topic
- subjectEvidence: when isSubject is true, a list of 1-4 exact substrings taken from the Title or Summary
- momentEvidence: a list of 1-4 exact substrings taken from the Title or Summary that support momentKind
- confidence: "high" | "medium" | "low". Use "low" when the kind is mostly inferred and not supported by explicit anchors.

Source rules:
- Cursor-style content is usually attempts and decisions, not solutions.
- Treat a merged pull request as a solution. If a pull request appears closed without merging, treat it as an attempt or decision, not a solution.

Output format:
- Return a single JSON array.
- Each item must have: index (1-based), momentKind, isSubject, subjectKind, subjectReason, subjectEvidence, momentEvidence, confidence.
- Do not include any extra text.

Document: ${input.documentId}

Macro moments:
${momentsText}
`;

  const raw = await callLLM(prompt, "slow-reasoning");

  let parsed: any[];
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch {
    return { macroMoments: input.macroMoments, classifications: null };
  }

  const byIndex = new Map<number, any>();
  for (const item of parsed) {
    const index = parseInt(item?.index, 10);
    if (!isNaN(index) && index >= 1 && index <= input.macroMoments.length) {
      byIndex.set(index, item);
    }
  }

  const safeMomentKind = (v: any) => 
    ["problem", "challenge", "opportunity", "initiative", "attempt", "decision", "solution"].includes(v?.toLowerCase()) ? v.toLowerCase() : null;
  const safeConfidence = (v: any) => ["high", "medium", "low"].includes(v?.toLowerCase()) ? v.toLowerCase() : "low";

  for (let i = 0; i < input.macroMoments.length; i++) {
    const item = byIndex.get(i + 1);
    if (!item) continue;

    const momentKind = safeMomentKind(item.momentKind);
    if (!momentKind) continue;

    const isSubject = Boolean(item.isSubject);
    (input.macroMoments[i] as any).momentKind = momentKind;
    (input.macroMoments[i] as any).momentEvidence = Array.isArray(item.momentEvidence) ? item.momentEvidence : [];
    (input.macroMoments[i] as any).isSubject = isSubject;
    (input.macroMoments[i] as any).subjectKind = isSubject ? (safeMomentKind(item.subjectKind) ?? momentKind) : null;
    (input.macroMoments[i] as any).subjectReason = isSubject ? (item.subjectReason || null) : null;
    (input.macroMoments[i] as any).subjectEvidence = isSubject ? (Array.isArray(item.subjectEvidence) ? item.subjectEvidence : []) : [];
    (input.macroMoments[i] as any).classificationConfidence = safeConfidence(item.confidence);
  }

  return { macroMoments: input.macroMoments, classifications: parsed };
}

export async function runMacroClassification(input: {
  document: Document;
  context: PipelineContext;
  streams: Array<{ streamId: string; macroMoments: MacroMomentDescription[] }>;
}): Promise<{
  streams: Array<{ streamId: string; macroMoments: MacroMomentDescription[] }>;
  gatingAuditByStream: any[];
  classificationsByStream: any[];
}> {
  const { document, context, streams } = input;

  const gatingConfig: MacroGatingConfig = {
    macroMaxPerStream: Number(context.env.MACRO_MAX_PER_STREAM) || 12,
    macroMinImportance: Number(context.env.MACRO_MIN_IMPORTANCE) || 0,
    noisePatternStringsFromEnv: [], // TODO: pull from env if needed
    discordNoisePatternStringsFromEnv: [],
  };

  const outStreams: any[] = [];
  const gatingAuditByStream: any[] = [];
  const classificationsByStream: any[] = [];

  for (const s of streams) {
    const gated = gateMacroMoments(s.macroMoments, gatingConfig);
    
    let classifications: any[] | null = null;
    if (gated.macroMomentDescriptions.length > 0) {
      const res = await classifyMacroMoments({
        documentId: document.id,
        macroMoments: gated.macroMomentDescriptions,
        context,
      });
      classifications = res.classifications;
    }

    gatingAuditByStream.push({ streamId: s.streamId, gating: gated.gatingAudit });
    classificationsByStream.push({ streamId: s.streamId, classifications });
    outStreams.push({ streamId: s.streamId, macroMoments: gated.macroMomentDescriptions });
  }

  return {
    streams: outStreams,
    gatingAuditByStream,
    classificationsByStream,
  };
}
