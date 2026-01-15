import type { SimulationDbContext } from "../../../adapters/simulation/types";
import { getSimulationDb } from "../../../adapters/simulation/db";
import { classifyMacroMoments } from "../../../subjects/classifyMacroMoments";

type MacroMomentDescription = {
  title?: string;
  summary?: string;
  microPaths?: string[];
  createdAt?: string;
  author?: string;
  importance?: number;
  [key: string]: any;
};

type MacroStream = { streamId: string; macroMoments: MacroMomentDescription[] };

function safeParseJson(value: unknown): any {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  if (n < 0) {
    return 0;
  }
  if (n > 1) {
    return 1;
  }
  return n;
}

export async function runMacroClassificationAdapter(
  context: SimulationDbContext,
  input: {
    runId: string;
    r2Keys: string[];
    now: string;
    log: { error: (kind: string, payload: any) => Promise<void> };
  }
): Promise<{
  docsProcessed: number;
  streamsIn: number;
  streamsOut: number;
  macroIn: number;
  macroOut: number;
  failed: number;
  failures: Array<{ r2Key: string; error: string }>;
}> {
  const db = getSimulationDb(context);
  const env = context.env as any;

  const macroMaxPerStreamRaw = env.MACRO_MOMENT_MAX_PER_STREAM;
  const macroMaxPerStream =
    typeof macroMaxPerStreamRaw === "string"
      ? Number.parseInt(macroMaxPerStreamRaw, 10)
      : typeof macroMaxPerStreamRaw === "number"
      ? macroMaxPerStreamRaw
      : 12;

  const macroMinImportanceRaw = env.MACRO_MOMENT_MIN_IMPORTANCE;
  const macroMinImportance =
    typeof macroMinImportanceRaw === "string"
      ? Number.parseFloat(macroMinImportanceRaw)
      : typeof macroMinImportanceRaw === "number"
      ? macroMinImportanceRaw
      : 0;

  const noisePatternsFromEnvRaw = env.MACRO_MOMENT_NOISE_PATTERNS;
  const noisePatternStringsFromEnv =
    typeof noisePatternsFromEnvRaw === "string"
      ? noisePatternsFromEnvRaw
          .split(/\r?\n|,/g)
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
      : [];

  const discordNoisePatternsFromEnvRaw = env.MACRO_MOMENT_DISCORD_NOISE_PATTERNS;
  const discordNoisePatternStringsFromEnv =
    typeof discordNoisePatternsFromEnvRaw === "string"
      ? discordNoisePatternsFromEnvRaw
          .split(/\r?\n|,/g)
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
      : [];

  const noiseRegexes = [
    "\\bdependabot\\b",
    "\\bdeployment preview\\b",
    "\\bpreview deployment\\b",
    "\\bcloudflare pages\\b",
    "\\b(successful deployment|deployed successfully)\\b",
    ...noisePatternStringsFromEnv,
  ]
    .map((p) => {
      try {
        return new RegExp(p, "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean) as RegExp[];

  const discordNoiseRegexes = [
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
    ...discordNoisePatternStringsFromEnv,
  ]
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
    const title = typeof m?.title === "string" ? m.title : "";
    const summary = typeof m?.summary === "string" ? m.summary : "";
    const author = typeof m?.author === "string" ? m.author : "";

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

  function gateMacroMoments(macroMoments: MacroMomentDescription[]): {
    kept: MacroMomentDescription[];
    audit: Record<string, any>;
  } {
    const withIndex = macroMoments
      .map((m, idx) => ({
        idx,
        m,
        importance: typeof m?.importance === "number" ? m.importance : 0,
      }))
      .filter((x) => !isNoiseMacroMoment(x.m));

    const auditBase: any = {
      inputMacroCount: macroMoments.length,
      outputMacroCount: 0,
      noiseDroppedCount: macroMoments.length - withIndex.length,
    };

    if (withIndex.length === 0) {
      return { kept: [], audit: auditBase };
    }

    const sortedByImportance = withIndex
      .slice()
      .sort((a, b) => b.importance - a.importance || a.idx - b.idx);

    const max =
      Number.isFinite(macroMaxPerStream) && macroMaxPerStream > 0
        ? Math.floor(macroMaxPerStream)
        : 12;
    const capped = sortedByImportance.slice(0, max);
    const cappedSortedByIndex = capped.slice().sort((a, b) => a.idx - b.idx);

    const minImportance =
      Number.isFinite(macroMinImportance) && macroMinImportance >= 0
        ? macroMinImportance
        : 0;

    const filtered = cappedSortedByIndex.filter(
      (x) => (x.importance ?? 0) >= minImportance
    );

    if (filtered.length > 0) {
      return {
        kept: filtered.map((x) => x.m),
        audit: { ...auditBase, outputMacroCount: filtered.length, max, minImportance },
      };
    }

    const fallback = cappedSortedByIndex[0] ?? sortedByImportance[0];
    return {
      kept: fallback ? [fallback.m] : [],
      audit: { ...auditBase, outputMacroCount: fallback ? 1 : 0, max, minImportance },
    };
  }

  let docsProcessed = 0;
  let streamsIn = 0;
  let streamsOut = 0;
  let macroIn = 0;
  let macroOut = 0;
  let failed = 0;
  const failures: Array<{ r2Key: string; error: string }> = [];

  for (const r2Key of input.r2Keys) {
    const docState = (await db
      .selectFrom("simulation_run_documents")
      .select(["changed", "error_json"])
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .executeTakeFirst()) as any;

    const hadError = Boolean(docState?.error_json);
    const changedFlag = Number(docState?.changed ?? 1) !== 0;
    if (hadError) {
      continue;
    }
    if (!changedFlag) {
      continue;
    }

    const macroRow = (await db
      .selectFrom("simulation_run_macro_outputs")
      .select(["streams_json"])
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .executeTakeFirst()) as any;

    const rawStreams = safeParseJson(macroRow?.streams_json);
    const streams: MacroStream[] = Array.isArray(rawStreams) ? rawStreams : [];

    docsProcessed++;

    const outStreams: MacroStream[] = [];
    const perStreamAudit: any[] = [];
    const perStreamClassifications: any[] = [];

    streamsIn += streams.length;
    for (const s of streams) {
      const streamId =
        typeof (s as any)?.streamId === "string" ? (s as any).streamId : "stream";
      const macroMoments: MacroMomentDescription[] = Array.isArray((s as any)?.macroMoments)
        ? ((s as any).macroMoments as any[])
        : [];
      macroIn += macroMoments.length;

      const gated = gateMacroMoments(
        macroMoments.map((m) => ({
          ...m,
          importance:
            typeof (m as any)?.importance === "number"
              ? clamp01((m as any).importance)
              : 0,
        }))
      );

      let kept = gated.kept;

      let classifications: any | null = null;
      try {
        const classified = await classifyMacroMoments({
          documentId: r2Key,
          macroMoments: kept as any,
        });
        classifications = classified ?? null;
        if (classified) {
          const byIndex = new Map<number, any>();
          for (const c of classified) {
            byIndex.set(c.index, c);
          }
          kept = kept.map((m, i) => {
            const c = byIndex.get(i + 1);
            if (!c) {
              return m;
            }
            return {
              ...m,
              momentKind: c.momentKind,
              momentEvidence: c.momentEvidence,
              isSubject: c.isSubject,
              subjectKind: c.subjectKind,
              subjectReason: c.subjectReason,
              subjectEvidence: c.subjectEvidence,
              classificationConfidence: c.confidence,
            };
          });
        }
      } catch (e) {
        await input.log.error("macro_classification.error", {
          runId: input.runId,
          r2Key,
          streamId,
          message: e instanceof Error ? e.message : String(e),
        });
      }

      perStreamAudit.push({
        streamId,
        gating: gated.audit,
      });
      perStreamClassifications.push({
        streamId,
        classifications,
      });

      const out = { streamId, macroMoments: kept };
      outStreams.push(out);
      streamsOut += 1;
      macroOut += kept.length;
    }

    try {
      await db
        .insertInto("simulation_run_macro_classified_outputs")
        .values({
          run_id: input.runId,
          r2_key: r2Key,
          streams_json: JSON.stringify(outStreams),
          gating_json: JSON.stringify(perStreamAudit),
          classification_json: JSON.stringify(perStreamClassifications),
          created_at: input.now,
          updated_at: input.now,
        } as any)
        .onConflict((oc: any) =>
          oc.columns(["run_id", "r2_key"]).doUpdateSet({
            streams_json: JSON.stringify(outStreams),
            gating_json: JSON.stringify(perStreamAudit),
            classification_json: JSON.stringify(perStreamClassifications),
            updated_at: input.now,
          } as any)
        )
        .execute();
    } catch (e) {
      failed++;
      failures.push({
        r2Key,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    docsProcessed,
    streamsIn,
    streamsOut,
    macroIn,
    macroOut,
    failed,
    failures,
  };
}

