import type { SimulationDbContext, SimulationQueueMessage, SimulationRunRow } from "../simulation/types";
import { simulationPhases } from "../simulation/types";
import { tickSimulationRun } from "../runners/simulation/runner";
import { getSimulationDb } from "../simulation/db";
import { sql } from "rwsdk/db";
import { getPhaseByName } from "../../pipelines/registry";
import { executePhase } from "../runtime/orchestrator";
import { SimulationStrategies } from "../runtime";
import { createEngineContext } from "../index";
import { addSimulationRunEvent } from "../simulation/runEvents";
import { applyMomentGraphNamespacePrefixValue } from "../momentGraphNamespace";
import { registerParticipatingNamespace } from "../simulation/runNamespaces";

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
  env: Cloudflare.Env,
  ctx: ExecutionContext
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
            .select(["current_phase", "moment_graph_namespace", "moment_graph_namespace_prefix"])
            .where("run_id", "=", message.runId)
            .executeTakeFirst() as SimulationRunRow | undefined;
          
          if (!runRow) {
            console.warn(`[simulation-worker] Run ${message.runId} not found`);
            return;
          }

          const currentPhaseName = message.jobType === "simulation-batch" ? "micro_batches" : message.phase;
          
          const currentIdx = simulationPhases.indexOf(runRow.current_phase as any);
          const jobIdx = simulationPhases.indexOf(currentPhaseName as any);
          
          if (jobIdx < currentIdx) {
            console.warn(`[simulation-worker] Run ${message.runId} is in phase ${runRow.current_phase}, but got stale job for past phase ${currentPhaseName}. Skipping.`);
            return;
          }

          if (jobIdx > currentIdx + 1) {
            console.warn(`[simulation-worker] Run ${message.runId} is in phase ${runRow.current_phase}, but got job for far-future phase ${currentPhaseName}. Skipping.`);
            return;
          }

          const phaseDef = getPhaseByName(currentPhaseName);
          if (phaseDef) {
            // Setup context for simulation
            const strategies = {
              storage: new SimulationStrategies.ArtifactStorage(message.runId, db, env),
              transition: new SimulationStrategies.QueueTransition(
                (env as any).ENGINE_INDEXING_QUEUE as Queue<any>,
                message.runId
              ),
            };

            // PICK-UP LATCH: Refresh timestamp immediately upon receipt.
            // This decouples queue wait time from processing time.
            if ((message as any).r2Key) {
              await db.updateTable("simulation_run_documents")
                .set({ updated_at: new Date().toISOString() })
                .where("run_id", "=", message.runId)
                .where("r2_key", "=", (message as any).r2Key)
                .execute();
            }

            const logger: any = {
              info: (msg: string, data?: any) => {
                console.log(`[sim-worker:${currentPhaseName}] ${msg}`, data);
                ctx.waitUntil(addSimulationRunEvent(context, {
                  runId: message.runId,
                  level: "info",
                  kind: `${currentPhaseName}.log`,
                  payload: { message: msg, data, r2Key: message.r2Key, phase: currentPhaseName }
                }));
              },
              warn: (msg: string, data?: any) => {
                console.warn(`[sim-worker:${currentPhaseName}] ${msg}`, data);
                ctx.waitUntil(addSimulationRunEvent(context, {
                  runId: message.runId,
                  level: "warn",
                  kind: `${currentPhaseName}.log`,
                  payload: { message: msg, data, r2Key: message.r2Key, phase: currentPhaseName }
                }));
              },
              error: (msg: string, data?: any) => {
                console.error(`[sim-worker:${currentPhaseName}] ${msg}`, data);
                ctx.waitUntil(addSimulationRunEvent(context, {
                  runId: message.runId,
                  level: "error",
                  kind: `${currentPhaseName}.log`,
                  payload: { message: msg, data, r2Key: message.r2Key, phase: currentPhaseName }
                }));
              },
              debug: (msg: string, data?: any) => {
                // Debug logs only to console to save DB space, unless verified otherwise
                console.debug(`[sim-worker:${currentPhaseName}] ${msg}`, data);
              }
            };

            // Resolve Namespace/Scope
            // We attempt to load the resolved baseNamespace from the ingest_diff artifact.
            // If it's not found (e.g. during ingest_diff itself), we fallback to the run's default.
            const ingestDiffDef = getPhaseByName("ingest_diff");
            let baseNamespace = runRow.moment_graph_namespace ?? null;
            
            if (currentPhaseName !== "ingest_diff" && ingestDiffDef) {
              const ingestDiffArtifact = await strategies.storage.load<{ baseNamespace: string | null }>(
                  ingestDiffDef, 
                  message.r2Key
              );
              if (ingestDiffArtifact) {
                baseNamespace = ingestDiffArtifact.baseNamespace;
              }
            }

            const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
                baseNamespace,
                runRow.moment_graph_namespace_prefix ?? null
            );

            // Register participation if we have a resolved namespace
            if (effectiveNamespace) {
               await registerParticipatingNamespace(context, { 
                 runId: message.runId, 
                 namespace: effectiveNamespace 
               });
            }

            const engineContext = createEngineContext(env, "indexing");

            const pipelineContext: any = {
              ...engineContext,
              r2Key: message.r2Key,
              momentGraphNamespace: effectiveNamespace,
              storage: strategies.storage,
              logger,
            };

            logger.info("engine.context-initialized", { 
              runId: message.runId, 
              services: ["llm", "vector", "db", "plugins"] 
            });

            const output = await executePhase(phaseDef, message.r2Key, strategies, pipelineContext);

            // Record completion for the document/phase
            const updateCols: any = {
              processed_phases_json: sql`json_insert(COALESCE(processed_phases_json, '[]'), '$[#]', ${currentPhaseName})`,
              updated_at: new Date().toISOString()
            };

            if (currentPhaseName === "ingest_diff" && output && typeof (output as any).changed === "boolean") {
              updateCols.changed = (output as any).changed ? 1 : 0;
            }

            await db.updateTable("simulation_run_documents")
              .set(updateCols)
              .where("run_id", "=", message.runId)
              .where("r2_key", "=", message.r2Key)
              .where(sql`json_extract(COALESCE(processed_phases_json, '[]'), '$')`, "not like", `%${currentPhaseName}%`)
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

