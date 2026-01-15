import type { MacroMomentDescription } from "../../../types";

export type MacroClassificationPorts = {
  classifyMacroMoments: (input: {
    documentId: string;
    macroMoments: MacroMomentDescription[];
  }) => Promise<Array<{
    index: number;
    momentKind: string;
    isSubject: boolean;
    subjectKind: string | null;
    subjectReason: string | null;
    subjectEvidence: string[];
    momentEvidence: string[];
    confidence: "high" | "medium" | "low";
  }> | null>;
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
  const classified = await input.ports.classifyMacroMoments({
    documentId: input.documentId,
    macroMoments: input.macroMoments,
  });

  if (!classified) {
    return { macroMoments: input.macroMoments, classifications: null };
  }

  const byIndex = new Map<number, (typeof classified)[number]>();
  for (const c of classified) {
    byIndex.set(c.index, c);
  }

  for (let i = 0; i < input.macroMoments.length; i++) {
    const c = byIndex.get(i + 1);
    if (!c) {
      continue;
    }
    (input.macroMoments[i] as any).momentKind = c.momentKind;
    (input.macroMoments[i] as any).momentEvidence = c.momentEvidence;
    (input.macroMoments[i] as any).isSubject = c.isSubject;
    (input.macroMoments[i] as any).subjectKind = c.subjectKind;
    (input.macroMoments[i] as any).subjectReason = c.subjectReason;
    (input.macroMoments[i] as any).subjectEvidence = c.subjectEvidence;
    if ((c as any).confidence) {
      (input.macroMoments[i] as any).classificationConfidence = (
        c as any
      ).confidence;
    }
  }

  return {
    macroMoments: input.macroMoments,
    classifications: classified as any,
  };
}
