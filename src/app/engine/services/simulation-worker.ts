import type { SimulationDbContext, SimulationQueueMessage, SimulationRunRow } from "../simulation/types";
import { tickSimulationRun } from "../runners/simulation/runner";
import { getSimulationDb } from "../simulation/db";
import { sql } from "rwsdk/db";
import { getPhaseByName } from "../../pipelines/registry";
import { executePhase } from "../runtime/orchestrator";
import { SimulationStrategies } from "../runtime";
import { createEngineContext } from "../index";
import { addSimulationRunEvent } from "../simulation/runEvents";

/**
 * Centrally tracks simulation job failures in the database for UI transparency,
 * then re-throws the error to allow native infrastructure retries and DLQs.
 */
async function withSimulationErrorTracking<T>(
  context: SimulationDbContext,
  runId: string,
  r2Key: string | undefined,
  phaseName: string | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const db = getSimulationDb(context);
  try {
    return await fn();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    const errorJson = JSON.stringify({ message: errorMsg, stack: errorStack });

    console.error(`[simulation-worker] Error in phase ${phaseName ?? "unknown"}:`, error);

    // Record error to the database
    if (r2Key) {
      await db.updateTable("simulation_run_documents")
        .set({ error_json: errorJson })
        .where("run_id", "=", runId)
        .where("r2_key", "=", r2Key)
        .execute();
    } else {
      await db.updateTable("simulation_runs")
        .set({ last_error_json: errorJson })
        .where("run_id", "=", runId)
        .execute();
    }

    // Add error event
    await addSimulationRunEvent(context, {
      runId,
      level: "error",
      kind: `${phaseName ?? "job"}.error`,
      payload: { 
        message: errorMsg, 
        stack: errorStack, 
        r2Key, 
        phase: phaseName 
      },
    });

    throw error; // Re-throw for Cloudflare native retries
  }
}

export async function processSimulationJob(
  message: SimulationQueueMessage,
  env: Cloudflare.Env
): Promise<void> {
  const context: SimulationDbContext = {
    env,
    momentGraphNamespace: null, // Runners will resolve from config if needed
  };

  console.log(`[simulation-worker] Received job of type: ${message.jobType}`, {
    runId: message.runId,
  });

  const db = getSimulationDb(context);

  // Wrap all simulation jobs with central error tracking
  const phaseName = message.jobType === "simulation-batch" ? "micro_batches" : 
                    message.jobType === "simulation-document" ? (message as any).phase : 
                    undefined;

  await withSimulationErrorTracking(
    context, 
    message.runId, 
    (message as any).r2Key, 
    phaseName,
    async () => {
      switch (message.jobType) {
        case "simulation-advance": {
          await tickSimulationRun(context, {
            runId: message.runId,
            continueOnError: true,
          });
          break;
        }

        case "simulation-document":
        case "simulation-batch": {
          const runRow = await db
            .selectFrom("simulation_runs")
            .select(["current_phase", "moment_graph_namespace"])
            .where("run_id", "=", message.runId)
            .executeTakeFirst() as SimulationRunRow | undefined;
          
          if (!runRow) {
            console.warn(`[simulation-worker] Run ${message.runId} not found`);
            return;
          }

          const currentPhaseName = message.jobType === "simulation-batch" ? "micro_batches" : message.phase;
          
          if (runRow.current_phase !== currentPhaseName) {
            console.warn(`[simulation-worker] Run ${message.runId} is in phase ${runRow.current_phase}, but got job for ${currentPhaseName}. Skipping.`);
            return;
          }

          const phaseDef = getPhaseByName(currentPhaseName);
          if (phaseDef) {
            // Setup context for simulation
            const strategies = {
              storage: new SimulationStrategies.ArtifactStorage(message.runId, db),
              transition: new SimulationStrategies.QueueTransition(
                (env as any).ENGINE_INDEXING_QUEUE as Queue<any>,
                message.runId
              ),
            };

            const pipelineContext: any = {
              ...context,
              r2Key: message.r2Key,
              momentGraphNamespace: runRow.moment_graph_namespace,
              storage: strategies.storage,
              // Use real plugins instead of empty array
              plugins: createEngineContext(env, "indexing").plugins,
            };

            pipelineContext.heartbeat = async () => {
              const table = currentPhaseName === "micro_batches" ? "simulation_run_micro_batches" : "simulation_run_documents";
              const query = db.updateTable(table as any)
                .set({ updated_at: new Date().toISOString() })
                .where("run_id", "=", message.runId)
                // @ts-ignore - r2_key exists on both tables
                .where("r2_key", "=", message.r2Key);
              
              if (message.jobType === "simulation-batch" && "batchIndex" in message) {
                await (query as any).where("batch_index", "=", message.batchIndex).execute();
              } else {
                await query.execute();
              }
            };

            await executePhase(phaseDef, message.r2Key, strategies, pipelineContext);

            // Record completion for the document/phase
            await db.updateTable("simulation_run_documents")
              .set({
                processed_phases_json: sql`json_insert(processed_phases_json, '$[#]', ${currentPhaseName})`,
                updated_at: new Date().toISOString()
              })
              .where("run_id", "=", message.runId)
              .where("r2_key", "=", message.r2Key)
              .where(sql`json_extract(processed_phases_json, '$')`, "not like", `%${currentPhaseName}%`)
              .execute();

            // Trigger advance check
            const queue = (env as any).ENGINE_INDEXING_QUEUE;
            if (queue) {
              await queue.send({ jobType: "simulation-advance", runId: message.runId });
            }
          }
          break;
        }

        default: {
          console.error(`[simulation-worker] Unknown job type: ${(message as any).jobType}`);
        }
      }
    }
  );
}

