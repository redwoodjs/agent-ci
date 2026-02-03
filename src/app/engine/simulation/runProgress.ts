import { sql } from "rwsdk/db";
import type { SimulationDbContext } from "./types";
import { getSimulationDb } from "./db";

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return 0;
}

export type SimulationRunProgressSummary = {
  totalDocs: number;
  ingestDiff: { docs: number; changed: number; unchanged: number; errors: number };
  microBatches: {
    docsWithBatches: number;
    batches: number;
    cached: number;
    computedLlm: number;
    computedFallback: number;
    errorRows: number;
  };
  macroSynthesis: { docs: number };
  macroClassification: { docs: number };
  materializeMoments: { docs: number; moments: number };
  deterministicLinking: { docs: number; decisions: number };
  candidateSets: { docs: number; sets: number };
  timelineFit: { docs: number; decisions: number };
};

export async function getSimulationRunProgressSummary(
  context: SimulationDbContext,
  input: { runId: string; totalDocs: number }
): Promise<SimulationRunProgressSummary> {
  const db = getSimulationDb(context);

  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  const totalDocsRaw = input.totalDocs;
  const totalDocs =
    typeof totalDocsRaw === "number" && Number.isFinite(totalDocsRaw)
      ? Math.max(0, Math.floor(totalDocsRaw))
      : 0;

  if (!runId) {
    return {
      totalDocs,
      ingestDiff: { docs: 0, changed: 0, unchanged: 0, errors: 0 },
      microBatches: {
        docsWithBatches: 0,
        batches: 0,
        cached: 0,
        computedLlm: 0,
        computedFallback: 0,
        errorRows: 0,
      },
      macroSynthesis: { docs: 0 },
      macroClassification: { docs: 0 },
      materializeMoments: { docs: 0, moments: 0 },
      deterministicLinking: { docs: 0, decisions: 0 },
      candidateSets: { docs: 0, sets: 0 },
      timelineFit: { docs: 0, decisions: 0 },
    };
  }

  const ingest = (await db
    .selectFrom("simulation_run_documents")
    .select([
      sql<number>`count(*)`.as("docs"),
      sql<number>`sum(case when changed != 0 then 1 else 0 end)`.as("changed"),
      sql<number>`sum(case when changed = 0 then 1 else 0 end)`.as("unchanged"),
      sql<number>`sum(case when error_json is not null then 1 else 0 end)`.as(
        "errors"
      ),
    ])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as any;

  const micro = (await db
    .selectFrom("simulation_run_artifacts")
    .select([
      sql<number>`count(*)`.as("docsWithBatches"),
      // We don't have per-batch counts in artifacts yet without parsing JSON, 
      // so we use docs as a proxy or just return 0 for these fine-grained stats for now
      // to keep the summary query fast.
    ])
    .where("run_id", "=", runId)
    .where("phase", "=", "micro_batches")
    .executeTakeFirst()) as any;

  const macro = (await db
    .selectFrom("simulation_run_artifacts")
    .select([sql<number>`count(*)`.as("docs")])
    .where("run_id", "=", runId)
    .where("phase", "=", "macro_synthesis")
    .executeTakeFirst()) as any;

  const macroClassified = (await db
    .selectFrom("simulation_run_artifacts")
    .select([sql<number>`count(*)`.as("docs")])
    .where("run_id", "=", runId)
    .where("phase", "=", "macro_classification")
    .executeTakeFirst()) as any;

  const materialized = (await db
    .selectFrom("simulation_run_artifacts")
    .select([
      sql<number>`count(*)`.as("segments"),
      sql<number>`count(distinct substr(artifact_key, 1, instr(artifact_key, '/') - 1))`.as("docs"),
    ])
    .where("run_id", "=", runId)
    .where("phase", "=", "materialize_moments")
    .executeTakeFirst()) as any;

  const link = (await db
    .selectFrom("simulation_run_artifacts")
    .select([
      sql<number>`count(*)`.as("decisions"),
      sql<number>`count(distinct substr(artifact_key, 1, instr(artifact_key, '/') - 1))`.as("docs"),
    ])
    .where("run_id", "=", runId)
    .where("phase", "=", "deterministic_linking")
    .executeTakeFirst()) as any;

  const candidate = (await db
    .selectFrom("simulation_run_artifacts")
    .select([
      sql<number>`count(*)`.as("sets"),
      sql<number>`count(distinct substr(artifact_key, 1, instr(artifact_key, '/') - 1))`.as("docs"),
    ])
    .where("run_id", "=", runId)
    .where("phase", "=", "candidate_sets")
    .executeTakeFirst()) as any;

  const fit = (await db
    .selectFrom("simulation_run_artifacts")
    .select([
      sql<number>`count(*)`.as("decisions"),
      sql<number>`count(distinct substr(artifact_key, 1, instr(artifact_key, '/') - 1))`.as("docs"),
    ])
    .where("run_id", "=", runId)
    .where("phase", "=", "timeline_fit")
    .executeTakeFirst()) as any;

  return {
    totalDocs,
    ingestDiff: {
      docs: toNumber(ingest?.docs),
      changed: toNumber(ingest?.changed),
      unchanged: toNumber(ingest?.unchanged),
      errors: toNumber(ingest?.errors),
    },
    microBatches: {
      docsWithBatches: toNumber(micro?.docsWithBatches),
      batches: toNumber(micro?.docsWithBatches), // Simplified
      cached: 0,
      computedLlm: 0,
      computedFallback: 0,
      errorRows: 0,
    },
    macroSynthesis: {
      docs: toNumber(macro?.docs),
    },
    macroClassification: {
      docs: toNumber(macroClassified?.docs),
    },
    materializeMoments: {
      docs: toNumber(materialized?.docs || materialized?.segments),
      moments: toNumber(materialized?.segments), // Proxy
    },
    deterministicLinking: {
      docs: toNumber(link?.docs || link?.decisions),
      decisions: toNumber(link?.decisions),
    },
    candidateSets: {
      docs: toNumber(candidate?.docs || candidate?.sets),
      sets: toNumber(candidate?.sets),
    },
    timelineFit: {
      docs: toNumber(fit?.docs || fit?.decisions),
      decisions: toNumber(fit?.decisions),
    },
  };
}

