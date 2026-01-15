import type { SimulationDbContext } from "../../../adapters/simulation/types";
import { getSimulationDb } from "../../../adapters/simulation/db";
import type { MacroMomentDescription } from "../../../types";
import { runMacroClassificationForDocument } from "../core/orchestrator";

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

export async function runMacroClassificationAdapter(
  context: SimulationDbContext,
  input: {
    runId: string;
    r2Keys: string[];
    now: string;
    log: { error: (kind: string, payload: any) => Promise<void> };
    ports: { callLLM: (prompt: string) => Promise<string> };
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

  const discordNoisePatternsFromEnvRaw =
    env.MACRO_MOMENT_DISCORD_NOISE_PATTERNS;
  const discordNoisePatternStringsFromEnv =
    typeof discordNoisePatternsFromEnvRaw === "string"
      ? discordNoisePatternsFromEnvRaw
          .split(/\r?\n|,/g)
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
      : [];

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

    try {
      const res = await runMacroClassificationForDocument({
        ports: input.ports,
        documentId: r2Key,
        streams,
        gating: {
          macroMaxPerStream,
          macroMinImportance,
          noisePatternStringsFromEnv,
          discordNoisePatternStringsFromEnv,
        },
      });
      outStreams.push(...res.streams);
      perStreamAudit.push(...res.gatingAuditByStream);
      perStreamClassifications.push(...res.classificationsByStream);
      streamsIn += res.counts.streamsIn;
      streamsOut += res.counts.streamsOut;
      macroIn += res.counts.macroIn;
      macroOut += res.counts.macroOut;
    } catch (e) {
      failed++;
      failures.push({
        r2Key,
        error: e instanceof Error ? e.message : String(e),
      });
      await input.log.error("macro_classification.error", {
        runId: input.runId,
        r2Key,
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
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
