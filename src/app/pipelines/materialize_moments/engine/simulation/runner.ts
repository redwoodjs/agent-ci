import { applyMomentGraphNamespacePrefixValue } from "../../../../engine/momentGraphNamespace";
import type { SimulationDbContext } from "../../../../engine/simulation/types";
import {
  getMomentGraphDb,
  getSimulationDb,
} from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { simulationPhases } from "../../../../engine/simulation/types";
import { runMaterializeMomentsAdapter } from "./adapter";

export async function runPhaseMaterializeMoments(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number; r2Key?: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select([
      "status",
      "config_json",
      "moment_graph_namespace",
      "moment_graph_namespace_prefix",
    ])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as unknown as
    | {
        status: string;
        config_json: any;
        moment_graph_namespace: string | null;
        moment_graph_namespace_prefix: string | null;
      }
    | undefined;

  if (!runRow) {
    return null;
  }

  const baseNamespace = runRow.moment_graph_namespace;
  const prefix = runRow.moment_graph_namespace_prefix;
  const effectiveNamespace = applyMomentGraphNamespacePrefixValue(baseNamespace, prefix);

  // 1. Get relevant documents (those that were changed in ingest_diff)
  const changedDocs = await db
    .selectFrom("simulation_run_documents")
    .select("r2_key")
    .where("run_id", "=", input.runId)
    .where("changed", "=", 1)
    .where("error_json", "is", null)
    .execute();
  
  const relevantR2Keys = changedDocs.map(d => d.r2_key);

  if (!input.r2Key) {
    // Polling / Startup mode
    if (relevantR2Keys.length === 0) {
      return advance(db, input.runId, input.phaseIdx, now);
    }

    // A document is considered "done" if it has at least one entry in simulation_run_materialized_moments
    // OR if it's been processed by the adapter. 
    // Actually, let's use a distinct set of keys that have been processed.
    const processedKeys = await db
      .selectFrom("simulation_run_documents")
      .select(["r2_key", "dispatched_phases_json", "processed_phases_json"])
      .where("run_id", "=", input.runId)
      .execute();
    
    const finishedSet = new Set(processedKeys.filter(k => (((k as any).processed_phases_json || []) as string[]).includes("materialize_moments")).map(k => k.r2_key));
    const processedSet = new Set(processedKeys.map(k => k.r2_key));
    const dispatchMap = new Map(processedKeys.map(k => [k.r2_key, (k.dispatched_phases_json || []) as string[]]));

    const missingKeys = relevantR2Keys.filter(k => !finishedSet.has(k));
    const undecpatchedKeys = relevantR2Keys.filter(k => {
      const dispatched = dispatchMap.get(k) || [];
      return !dispatched.includes("materialize_moments");
    });

    if (undecpatchedKeys.length > 0) {
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (queue) {
        await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "info",
          kind: "phase.dispatch_docs",
          payload: { phase: "materialize_moments", count: undecpatchedKeys.length },
        });

        for (const k of undecpatchedKeys) {
          const dispatched = (dispatchMap.get(k) || []) as string[];
          const nextDispatched = [...new Set([...dispatched, "materialize_moments"])];
          
          await db
            .insertInto("simulation_run_documents")
            .values({
              run_id: input.runId,
              r2_key: k,
              changed: 1, // Must be 1 if we're here
              processed_at: "pending",
              updated_at: now,
              dispatched_phases_json: nextDispatched,
              processed_phases_json: [],
            } as any)
            .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
              dispatched_phases_json: nextDispatched,
              updated_at: now,
            } as any))
            .execute();

          await queue.send({
            jobType: "simulation-document",
            runId: input.runId,
            phase: "materialize_moments",
            r2Key: k,
          });
        }
        return { status: "awaiting_documents", currentPhase: "materialize_moments" };
      }
      throw new Error("ENGINE_INDEXING_QUEUE is required");
    }

    if (missingKeys.length > 0) {
      return { status: "awaiting_documents", currentPhase: "materialize_moments" };
    }

    return advance(db, input.runId, input.phaseIdx, now);
  }

  // Granular execution
  const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);

  await runMaterializeMomentsAdapter(context, {
    runId: input.runId,
    r2Keys: [input.r2Key],
    effectiveNamespace: effectiveNamespace ?? null,
    momentDb,
    now,
    log,
  });

  // Mark doc as processed for this phase
  const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", input.r2Key).executeTakeFirst();
  const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
  const nextPhases = [...new Set([...currentPhases, "materialize_moments"])];
  await db.updateTable("simulation_run_documents")
    .set({ processed_phases_json: nextPhases as any, updated_at: now })
    .where("run_id", "=", input.runId)
    .where("r2_key", "=", input.r2Key)
    .execute();

  return { status: "running", currentPhase: "materialize_moments" };
}

async function advance(db: any, runId: string, phaseIdx: number, now: string) {
  const nextPhase = simulationPhases[phaseIdx + 1] ?? null;
  if (!nextPhase) {
    await db.updateTable("simulation_runs").set({ status: "completed", updated_at: now }).where("run_id", "=", runId).execute();
    return { status: "completed", currentPhase: "materialize_moments" };
  }
  await db.updateTable("simulation_runs").set({ current_phase: nextPhase, updated_at: now }).where("run_id", "=", runId).execute();
  return { status: "running", currentPhase: nextPhase };
}
