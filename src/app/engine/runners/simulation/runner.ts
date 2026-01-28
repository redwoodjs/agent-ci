import type { SimulationDbContext } from "../../simulation/types";
import type { SimulationPhase } from "../../simulation/types";
import { simulationPhases } from "../../simulation/types";
import { normalizePhase } from "../../simulation/runs";
import { getSimulationDb } from "../../simulation/db";
import { addSimulationRunEvent } from "../../simulation/runEvents";
import { pipelineRegistry } from "../../simulation/allPipelines";

// No longer need hardcoded phaseRunners mapping here


export async function advanceSimulationRunPhaseNoop(
  context: SimulationDbContext,
  input: { runId: string; continueOnError?: boolean }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return null;
  }

  const row = (await db
    .selectFrom("simulation_runs")
    .select(["status", "current_phase", "updated_at"])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as unknown as
    | { status: string; current_phase: string; updated_at: string }
    | undefined;

  if (!row) {
    return null;
  }

  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const isStaleLock = row.status === "busy_running" && row.updated_at < fiveMinutesAgo;

  if (
    row.status !== "running" &&
    row.status !== "awaiting_documents" &&
    !isStaleLock
  ) {
    return { status: row.status, currentPhase: row.current_phase };
  }

  // Atomically set status to busy_running to prevent concurrent advancement
  // We allow breaking a "busy_running" lock if it hasn't been updated for more than 5 minutes
  const now = new Date().toISOString();
  
  await db
    .updateTable("simulation_runs")
    .set({
      status: "busy_running",
      updated_at: now,
    } as any)
    .where("run_id", "=", runId)
    .where((eb) => eb.or([
      eb("status", "in", ["running", "awaiting_documents"]),
      eb.and([
        eb("status", "=", "busy_running"),
        eb("updated_at", "<", fiveMinutesAgo)
      ])
    ]))
    .execute();

  if (isStaleLock) {
    console.warn(`[runner] Breaking stale busy_running lock for run ${runId} (last updated ${row.updated_at})`);
    await addSimulationRunEvent(context, {
      runId,
      level: "warn",
      kind: "host.lock_broken",
      payload: { status: row.status, lastUpdatedAt: row.updated_at },
    });
  }

  // Verify we actually got the lock
  const refreshed = (await db
    .selectFrom("simulation_runs")
    .select(["status"])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as { status: string } | undefined;

  if (refreshed?.status !== "busy_running") {
    return {
      status: refreshed?.status ?? row.status,
      currentPhase: row.current_phase,
    };
  }

  const phase = normalizePhase(row.current_phase);
  const phaseIdx = simulationPhases.indexOf(phase);

  await addSimulationRunEvent(context, {
    runId,
    level: "debug",
    kind: "host.phase.dispatch",
    payload: { phase, phaseIdx },
  });

  try {
    const entry = pipelineRegistry[phase];
    if (!entry) {
      throw new Error(`No registry entry found for phase: ${phase}`);
    }

    // Supervisor Check: Sweep for zombies
    // This expects all phases to implement recoverZombies (enforced by type)
    await entry.recoverZombies(context, { runId });

    const result = await entry.runner(context, {
      runId,
      phaseIdx,
    });

    let finalStatus = result?.status ?? "running";
    if (finalStatus === "busy_running") {
      finalStatus = "running";
    }

    if (finalStatus === "paused_on_error" && input.continueOnError) {
      // If phase runner reported error but we want to continue, force advance to next phase
      const nextPhase = simulationPhases[phaseIdx + 1] ?? null;
      if (nextPhase) {
        if ((context.env as any).ENGINE_INDEXING_QUEUE) {
          await (context.env as any).ENGINE_INDEXING_QUEUE.send({
            jobType: "simulation-advance",
            runId,
          });
          return { status: "running", currentPhase: nextPhase };
        }
        await db
          .updateTable("simulation_runs")
          .set({
            status: "running",
            current_phase: nextPhase,
            updated_at: new Date().toISOString(),
          } as any)
          .where("run_id", "=", runId)
          .execute();
        return { status: "running", currentPhase: nextPhase };
      }
    }

    if (finalStatus === "running" && (context.env as any).ENGINE_INDEXING_QUEUE) {
       await (context.env as any).ENGINE_INDEXING_QUEUE.send({
         jobType: "simulation-advance",
         runId,
       });
    }

    // Set the status explicitly (clearing busy_running)
    await db
      .updateTable("simulation_runs")
      .set({ status: finalStatus, updated_at: new Date().toISOString() })
      .where("run_id", "=", runId)
      .execute();

    return { ...result, status: finalStatus, currentPhase: result?.currentPhase ?? phase };
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    console.error(`[runner] Crash in phase ${phase}: ${msg}`, stack);

    await addSimulationRunEvent(context, {
      runId,
      level: "error",
      kind: "phase.error",
      payload: { phase, error: msg, stack },
    });

    const now = new Date().toISOString();

    if (input.continueOnError) {
      const nextPhase = simulationPhases[phaseIdx + 1] ?? null;
      if (nextPhase) {
        await db
          .updateTable("simulation_runs")
          .set({
            status: "running",
            current_phase: nextPhase,
            updated_at: now,
            last_error_json: JSON.stringify({
              message: `Crashed in ${phase}: ${msg}`,
              phase,
              recovered: true,
            }),
          } as any)
          .where("run_id", "=", runId)
          .execute();
        return { status: "running", currentPhase: nextPhase };
      }
    }

    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: msg,
          phase,
          stack,
        }),
      } as any)
      .where("run_id", "=", runId)
      .execute();

    return { status: "paused_on_error", currentPhase: phase };
  } finally {
    // Ultimate safety: if we are still 'busy_running' (e.g. catch block failed to update DB)
    // we MUST reset to 'running' to let history continue.
    const finalCheck = await db
      .selectFrom("simulation_runs")
      .select("status")
      .where("run_id", "=", runId)
      .executeTakeFirst();
      
    if (finalCheck?.status === "busy_running") {
      await db
        .updateTable("simulation_runs")
        .set({ status: "running", updated_at: new Date().toISOString() })
        .where("run_id", "=", runId)
        .execute();
    }
  }
}

export async function autoAdvanceSimulationRun(
  context: SimulationDbContext,
  input: { runId: string; maxMs?: number; continueOnError?: boolean }
): Promise<{ status: string; currentPhase: string; steps: number }> {
  const startedAt = Date.now();
  const maxMs = input.maxMs ?? 25000; // Default 25s for Cloudflare worker limits (30s max)
  const continueOnError = input.continueOnError ?? true;
  let steps = 0;
  let lastResult: { status: string; currentPhase: string } | null = null;

  while (Date.now() - startedAt < maxMs) {
    const res = await advanceSimulationRunPhaseNoop(context, {
      runId: input.runId,
      continueOnError,
    });
    if (!res) {
      break;
    }
    lastResult = res;
    steps++;

    if (res.status !== "running") {
      break;
    }
  }

  if (!lastResult) {
    const db = getSimulationDb(context);
    const row = (await db
      .selectFrom("simulation_runs")
      .select(["status", "current_phase"])
      .where("run_id", "=", input.runId)
      .executeTakeFirst()) as { status: string; current_phase: string } | undefined;
    return {
      status: row?.status ?? "unknown",
      currentPhase: row?.current_phase ?? "unknown",
      steps,
    };
  }

  return { ...lastResult, steps };
}

