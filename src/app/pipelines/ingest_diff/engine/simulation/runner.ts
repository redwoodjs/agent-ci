import type { SimulationDbContext } from "../../../../engine/simulation/types";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { simulationPhases } from "../../../../engine/simulation/types";
import { runIngestDiffForKey } from "../core/orchestrator";

export async function runPhaseIngestDiff(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number; r2Key?: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const log = createSimulationRunLogger(context, { runId: input.runId });
  const now = new Date().toISOString();

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["status", "config_json"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as unknown as
    | { status: string; config_json: any }
    | undefined;

  if (!runRow) {
    return null;
  }

  const config = runRow.config_json ?? {};
  const r2KeysRaw = (config as any)?.r2Keys;
  const r2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : [];

  if (!input.r2Key) {
    // Check if we already have results for all keys
    const processedKeys = await db
      .selectFrom("simulation_run_documents")
      .selectAll()
      .where("run_id", "=", input.runId)
      .execute();
    
    const finishedSet = new Set(processedKeys.filter(k => (((k as any).processed_phases_json || []) as string[]).includes("ingest_diff")).map(k => k.r2_key));
    const processedSet = new Set(processedKeys.map(k => k.r2_key));
    const dispatchedMap = new Map(processedKeys.map(k => [k.r2_key, (k.dispatched_phases_json || []) as string[]]));
    
    const missingKeys = r2Keys.filter(k => !finishedSet.has(k));
    const undecpatchedKeys = r2Keys.filter(k => {
      if (processedSet.has(k)) {
        // Even if in processedSet, if it's "pending" and NOT in dispatched_phases_json (unlikely but safe), we skip re-dispatching
        const dispatched = dispatchedMap.get(k) || [];
        return !dispatched.includes("ingest_diff");
      }
      return true;
    });

    if (undecpatchedKeys.length > 0) {
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (queue) {
        await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "info",
          kind: "phase.dispatch_docs",
          payload: { phase: "ingest_diff", count: undecpatchedKeys.length },
        });

        for (const r2Key of undecpatchedKeys) {
          // Register the document if it doesn't exist, and mark as dispatched
          const dispatched = (dispatchedMap.get(r2Key) || []) as string[];
          const nextDispatched = [...new Set([...dispatched, "ingest_diff"])];
          
          await db
            .insertInto("simulation_run_documents")
            .values({
              run_id: input.runId,
              r2_key: r2Key,
              changed: 0,
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
            phase: "ingest_diff",
            r2Key,
          });
        }
        return { status: "awaiting_documents", currentPhase: "ingest_diff" };
      }
      
      throw new Error("ENGINE_INDEXING_QUEUE is required for async simulation runners");
    }

    if (missingKeys.length > 0) {
      // We have missing keys but they are all dispatched
      return { status: "awaiting_documents", currentPhase: "ingest_diff" };
    }

    // All keys have entries. Check if any have errors.
    const failures = await db
        .selectFrom("simulation_run_documents")
        .select(["r2_key", "error_json"])
        .where("run_id", "=", input.runId)
        .where("error_json", "is not", null)
        .execute();

    if (failures.length > 0) {
      await db
        .updateTable("simulation_runs")
        .set({
          status: "paused_on_error",
          updated_at: now,
          last_progress_at: now,
          last_error_json: JSON.stringify({
            message: "ingest_diff failed for one or more documents",
            failures: failures.map(f => ({ r2Key: f.r2_key, error: f.error_json })),
          }),
        } as any)
        .where("run_id", "=", input.runId)
        .execute();

      return { status: "paused_on_error", currentPhase: "ingest_diff" };
    }

    // Success! Advance phase.
    const nextPhase = simulationPhases[input.phaseIdx + 1] ?? null;
    if (!nextPhase) {
      await db
        .updateTable("simulation_runs")
        .set({
          status: "completed",
          updated_at: now,
          last_progress_at: now,
        } as any)
        .where("run_id", "=", input.runId)
        .execute();
      return { status: "completed", currentPhase: "ingest_diff" };
    }

    await db
      .updateTable("simulation_runs")
      .set({
        current_phase: nextPhase,
        updated_at: now,
        last_progress_at: now,
      } as any)
      .where("run_id", "=", input.runId)
      .execute();

    return { status: "running", currentPhase: nextPhase };
  }

  // Granular execution for a single key
  try {
    const result = await runIngestDiffForKey({
      ports: {
        headR2Key: async (k) => {
          const bucket = (context.env as any).MACHINEN_BUCKET;
          const head = await bucket.head(k);
          if (!head) throw new Error("R2 object not found");
          const etag = typeof head.etag === "string" ? head.etag : null;
          if (!etag) throw new Error("Missing R2 etag");
          return { etag };
        },
        loadPreviousEtag: async (k) => {
          const prev = (await db
            .selectFrom("simulation_run_documents")
            .select(["etag"])
            .where("run_id", "=", input.runId)
            .where("r2_key", "=", k)
            .executeTakeFirst()) as unknown as { etag: string | null } | undefined;
          return prev?.etag ?? null;
        },
        persistResult: async ({ r2Key, etag, changed }) => {
          const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", r2Key).executeTakeFirst();
          const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
          const nextPhases = [...new Set([...currentPhases, "ingest_diff"])];

          await db
            .insertInto("simulation_run_documents")
            .values({
              run_id: input.runId,
              r2_key: r2Key,
              etag,
              changed: changed ? 1 : 0,
              processed_at: now,
              updated_at: now,
              processed_phases_json: nextPhases,
            } as any)
            .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
                etag,
                changed: changed ? 1 : 0,
                processed_at: now,
                updated_at: now,
                processed_phases_json: nextPhases as any,
            } as any))
            .execute();
        },
        persistError: async ({ r2Key, error }) => {
          await log.error("item.error", { phase: "ingest_diff", r2Key, error });
          await db
            .insertInto("simulation_run_documents")
            .values({
              run_id: input.runId,
              r2_key: r2Key,
              changed: 1,
              error_json: { message: error },
              processed_at: now,
              updated_at: now,
            } as any)
            .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
                changed: 1,
                error_json: { message: error },
                processed_at: now,
                updated_at: now,
            } as any))
            .execute();
        },
      },
      r2Key: input.r2Key,
    });

    await log.info("item.success", { phase: "ingest_diff", r2Key: input.r2Key, changed: result.changed });
    return { status: "running", currentPhase: "ingest_diff" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log.error("item.error", { phase: "ingest_diff", r2Key: input.r2Key, error: msg });
    await db
      .insertInto("simulation_run_documents")
      .values({
        run_id: input.runId,
        r2_key: input.r2Key,
        changed: 1,
        error_json: JSON.stringify({ message: msg }),
        processed_at: now,
        updated_at: now,
      } as any)
      .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
          changed: 1,
          error_json: JSON.stringify({ message: msg }),
          processed_at: now,
          updated_at: now,
      } as any))
      .execute();
    return { status: "running", currentPhase: "ingest_diff" };
  }
}
