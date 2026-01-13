import type { SimulationDbContext } from "../types";
import { getSimulationDb } from "../db";
import { addSimulationRunEvent } from "../runEvents";
import { createSimulationRunLogger } from "../logger";
import { simulationPhases } from "../types";

export async function runPhaseIngestDiff(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const log = createSimulationRunLogger(context, { runId: input.runId });

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

  const config = (runRow as any).config_json ?? {};
  const r2KeysRaw = (config as any)?.r2Keys;
  const r2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : [];

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: { phase: "ingest_diff", r2KeysCount: r2Keys.length },
  });

  let succeeded = 0;
  let failed = 0;
  let changed = 0;
  let unchanged = 0;
  const failures: Array<{ r2Key: string; error: string }> = [];

  const now = new Date().toISOString();

  for (const r2Key of r2Keys) {
    try {
      const bucket = (context.env as any).MACHINEN_BUCKET;
      const head = await bucket.head(r2Key);
      if (!head) {
        throw new Error("R2 object not found");
      }
      const etag = typeof head.etag === "string" ? head.etag : null;
      if (!etag) {
        throw new Error("Missing R2 etag");
      }

      const prev = (await db
        .selectFrom("simulation_run_documents")
        .select(["etag"])
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", r2Key)
        .executeTakeFirst()) as unknown as { etag: string | null } | undefined;

      const wasEtag = typeof prev?.etag === "string" ? prev.etag : null;
      const isChanged = !wasEtag || wasEtag !== etag;

      if (isChanged) {
        changed++;
      } else {
        unchanged++;
      }

      await db
        .insertInto("simulation_run_documents")
        .values({
          run_id: input.runId,
          r2_key: r2Key,
          etag,
          document_hash: null,
          changed: isChanged ? (1 as any) : (0 as any),
          error_json: null,
          processed_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "r2_key"]).doUpdateSet({
            etag,
            document_hash: null,
            changed: isChanged ? (1 as any) : (0 as any),
            error_json: null,
            processed_at: now,
            updated_at: now,
          } as any)
        )
        .execute();

      succeeded++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ r2Key, error: msg });
      await log.error("item.error", {
        phase: "ingest_diff",
        r2Key,
        error: msg,
      });

      await db
        .insertInto("simulation_run_documents")
        .values({
          run_id: input.runId,
          r2_key: r2Key,
          etag: null,
          document_hash: null,
          changed: 1 as any,
          error_json: JSON.stringify({ message: msg }),
          processed_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "r2_key"]).doUpdateSet({
            etag: null,
            document_hash: null,
            changed: 1 as any,
            error_json: JSON.stringify({ message: msg }),
            processed_at: now,
            updated_at: now,
          } as any)
        )
        .execute();
    }
  }

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "ingest_diff",
      r2KeysCount: r2Keys.length,
      succeeded,
      failed,
      changed,
      unchanged,
      didWork: r2Keys.length > 0,
    },
  });

  if (failed > 0) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: "Phase A ingest+diff failed for one or more documents",
          failures,
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();

    return { status: "paused_on_error", currentPhase: "ingest_diff" };
  }

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

