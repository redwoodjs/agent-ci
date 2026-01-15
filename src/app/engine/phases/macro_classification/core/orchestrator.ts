import type { MacroMomentDescription } from "../../../types";

export type MacroClassificationPorts = {
  callLLM: (prompt: string) => Promise<string>;
};

export type MacroGatingConfig = {
  macroMaxPerStream: number;
  macroMinImportance: number;
  noisePatternStringsFromEnv: string[];
  discordNoisePatternStringsFromEnv: string[];
};

export function gateMacroMomentsLikeLiveEngine(
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
    if (!text) {
      return false;
    }
    if (text.includes("mchn://gh/")) {
      return true;
    }
    if (text.includes("```")) {
      return true;
    }
    if (/\b(error|exception|stack trace|traceback)\b/i.test(text)) {
      return true;
    }
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
    const title =
      typeof (m as any)?.title === "string" ? ((m as any).title as string) : "";
    const summary =
      typeof (m as any)?.summary === "string"
        ? ((m as any).summary as string)
        : "";
    const author =
      typeof (m as any)?.author === "string"
        ? ((m as any).author as string)
        : "";

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
      if (hasTechnicalAnchors(combined)) {
        return false;
      }
      for (const re of discordNoiseRegexes) {
        if (re.test(title) || re.test(summary)) {
          return true;
        }
      }
      return false;
    }

    if (!isGitHub) {
      return false;
    }

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
      if (re.test(title) || re.test(summary)) {
        return true;
      }
    }

    if (combinedLower.includes("closed issue")) {
      const hasTechnicalSignal =
        /\b(fix|fixed|bug|error|investigat|regression|implement|implemented|add|added|remove|removed|merge|merged|release|released|ship|shipped|deploy|deployed|rollback)\b/i.test(
          `${title}\n${summary}`
        );
      if (!hasTechnicalSignal) {
        return true;
      }
    }

    return false;
  }

  const withIndex = macroMomentDescriptionsRaw
    .map((m, idx) => ({
      idx,
      m,
      importance:
        m && typeof (m as any).importance === "number"
          ? ((m as any).importance as number)
          : 0,
    }))
    .filter((x) => !isNoiseMacroMoment(x.m));

  if (withIndex.length === 0) {
    return {
      macroMomentDescriptions: [] as MacroMomentDescription[],
      gatingAudit: {
        inputMacroCount: macroMomentDescriptionsRaw.length,
        outputMacroCount: 0,
        noiseDroppedCount: macroMomentDescriptionsRaw.length,
        noiseDroppedTitlesSample: macroMomentDescriptionsRaw
          .slice(0, 20)
          .map((m) =>
            typeof (m as any)?.title === "string"
              ? ((m as any).title as string)
              : null
          )
          .filter((t): t is string => typeof t === "string" && t.length > 0),
      },
    };
  }

  const sortedByImportance = withIndex
    .slice()
    .sort((a, b) => b.importance - a.importance || a.idx - b.idx);

  const max =
    Number.isFinite(config.macroMaxPerStream) && config.macroMaxPerStream > 0
      ? Math.floor(config.macroMaxPerStream)
      : 12;

  const capped = sortedByImportance.slice(0, max);
  const cappedSortedByIndex = capped.slice().sort((a, b) => a.idx - b.idx);

  const minImportance =
    Number.isFinite(config.macroMinImportance) && config.macroMinImportance >= 0
      ? config.macroMinImportance
      : 0;

  const filtered = cappedSortedByIndex.filter(
    (x) => x.importance >= minImportance
  );

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

export async function classifyMacroMomentsLikeLiveEngine(input: {
  ports: MacroClassificationPorts;
  documentId: string;
  macroMoments: MacroMomentDescription[];
}): Promise<{
  macroMoments: MacroMomentDescription[];
  classifications: any[] | null;
}> {
  if (input.macroMoments.length === 0) {
    return { macroMoments: [], classifications: [] };
  }

  function safeArrayOfStrings(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        const trimmed = item.trim();
        if (trimmed.length > 0) {
          out.push(trimmed);
        }
      }
    }
    return out;
  }

  function safeMomentKind(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const v = value.trim().toLowerCase();
    if (
      v === "problem" ||
      v === "challenge" ||
      v === "opportunity" ||
      v === "initiative" ||
      v === "attempt" ||
      v === "decision" ||
      v === "solution"
    ) {
      return v;
    }
    return null;
  }

  function safeSubjectKind(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const v = value.trim().toLowerCase();
    if (
      v === "problem" ||
      v === "challenge" ||
      v === "opportunity" ||
      v === "initiative"
    ) {
      return v;
    }
    return null;
  }

  function safeConfidence(value: unknown): "high" | "medium" | "low" {
    if (typeof value !== "string") {
      return "low";
    }
    const v = value.trim().toLowerCase();
    if (v === "high" || v === "medium" || v === "low") {
      return v;
    }
    return "low";
  }

  const momentsText = input.macroMoments
    .map((m, idx) => {
      const title = typeof m.title === "string" ? m.title : "";
      const summary = typeof m.summary === "string" ? m.summary : "";
      return `Index: ${idx + 1}\nTitle: ${title}\nSummary: ${summary}\n`;
    })
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

  const raw = await input.ports.callLLM(prompt);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { macroMoments: input.macroMoments, classifications: null };
  }

  if (!Array.isArray(parsed)) {
    return { macroMoments: input.macroMoments, classifications: null };
  }

  const classified = parsed as any[];

  const byIndex = new Map<number, any>();
  for (const item of classified) {
    const indexRaw = (item as any)?.index;
    const index =
      typeof indexRaw === "number" && Number.isFinite(indexRaw)
        ? Math.floor(indexRaw)
        : typeof indexRaw === "string"
        ? Number.parseInt(indexRaw, 10)
        : NaN;
    if (
      !Number.isFinite(index) ||
      index < 1 ||
      index > input.macroMoments.length
    ) {
      continue;
    }
    byIndex.set(index, item);
  }

  for (let i = 0; i < input.macroMoments.length; i++) {
    const item = byIndex.get(i + 1);
    if (!item) {
      continue;
    }

    const momentKind = safeMomentKind((item as any)?.momentKind);
    if (!momentKind) {
      continue;
    }

    const isSubject = Boolean((item as any)?.isSubject);
    const subjectKind = safeSubjectKind((item as any)?.subjectKind);
    const subjectReasonRaw = (item as any)?.subjectReason;
    const subjectReason =
      typeof subjectReasonRaw === "string" && subjectReasonRaw.trim().length > 0
        ? subjectReasonRaw.trim()
        : null;

    const subjectEvidence = safeArrayOfStrings((item as any)?.subjectEvidence);
    const momentEvidence = safeArrayOfStrings((item as any)?.momentEvidence);
    const confidence = safeConfidence((item as any)?.confidence);

    (input.macroMoments[i] as any).momentKind = momentKind;
    (input.macroMoments[i] as any).momentEvidence = momentEvidence;
    (input.macroMoments[i] as any).isSubject = isSubject;
    (input.macroMoments[i] as any).subjectKind = isSubject
      ? subjectKind ?? momentKind
      : null;
    (input.macroMoments[i] as any).subjectReason = isSubject
      ? subjectReason
      : null;
    (input.macroMoments[i] as any).subjectEvidence = isSubject
      ? subjectEvidence
      : [];
    (input.macroMoments[i] as any).classificationConfidence = confidence;
  }

  return {
    macroMoments: input.macroMoments,
    classifications: classified,
  };
}

type MacroStream = { streamId: string; macroMoments: MacroMomentDescription[] };

export async function runMacroClassificationForDocument(input: {
  ports: MacroClassificationPorts;
  documentId: string;
  streams: MacroStream[];
  gating: MacroGatingConfig;
}): Promise<{
  streams: MacroStream[];
  gatingAuditByStream: any[];
  classificationsByStream: any[];
  counts: {
    streamsIn: number;
    streamsOut: number;
    macroIn: number;
    macroOut: number;
  };
}> {
  const outStreams: MacroStream[] = [];
  const gatingAuditByStream: any[] = [];
  const classificationsByStream: any[] = [];

  let streamsIn = 0;
  let streamsOut = 0;
  let macroIn = 0;
  let macroOut = 0;

  streamsIn += input.streams.length;
  for (const s of input.streams) {
    const streamId =
      typeof (s as any)?.streamId === "string" ? (s as any).streamId : "stream";
    const macroMoments: MacroMomentDescription[] = Array.isArray(
      (s as any)?.macroMoments
    )
      ? ((s as any).macroMoments as any[])
      : [];
    macroIn += macroMoments.length;

    const gated = gateMacroMomentsLikeLiveEngine(macroMoments, input.gating);
    const macroMomentDescriptions = gated.macroMomentDescriptions;

    let classifications: any[] | null = null;
    if (macroMomentDescriptions.length > 0) {
      const res = await classifyMacroMomentsLikeLiveEngine({
        ports: input.ports,
        documentId: input.documentId,
        macroMoments: macroMomentDescriptions as any,
      });
      classifications = res.classifications ?? null;
    }

    gatingAuditByStream.push({ streamId, gating: gated.gatingAudit });
    classificationsByStream.push({ streamId, classifications });

    outStreams.push({ streamId, macroMoments: macroMomentDescriptions });
    streamsOut += 1;
    macroOut += macroMomentDescriptions.length;
  }

  return {
    streams: outStreams,
    gatingAuditByStream,
    classificationsByStream,
    counts: { streamsIn, streamsOut, macroIn, macroOut },
  };
}
