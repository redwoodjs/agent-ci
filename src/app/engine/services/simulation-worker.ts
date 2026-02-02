import type { SimulationDbContext, SimulationQueueMessage } from "../simulation/types";
import { tickSimulationRun } from "../runners/simulation/runner";
import { getSimulationDb } from "../simulation/db";
import { sql } from "rwsdk/db";
import { getPhaseByName } from "../../pipelines/registry";
import { executePhase } from "../runtime/orchestrator";
import { SimulationStrategies } from "../runtime";

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
        .executeTakeFirst();
      
      if (!runRow) {
        console.warn(`[simulation-worker] Run ${message.runId} not found`);
        return;
      }

      const phaseName = message.jobType === "simulation-batch" ? "micro_batches" : message.phase;
      
      if (runRow.current_phase !== phaseName) {
        console.warn(`[simulation-worker] Run ${message.runId} is in phase ${runRow.current_phase}, but got job for ${phaseName}. Skipping.`);
        return;
      }

      const phaseDef = getPhaseByName(phaseName);
      if (phaseDef) {
        // Setup context for simulation
        const strategies = {
          storage: new SimulationStrategies.ArtifactStorage(message.runId, db),
          transition: new SimulationStrategies.QueueTransition(
            (env as any).ENGINE_INDEXING_QUEUE,
            message.runId
          ),
        };

        const pipelineContext: any = {
          ...context,
          momentGraphNamespace: runRow.moment_graph_namespace,
          storage: strategies.storage,
          plugins: [], // Orchestrator or phase will resolve if needed
        };

        pipelineContext.heartbeat = async () => {
          const table = phaseName === "micro_batches" ? "simulation_run_micro_batches" : "simulation_run_documents";
          const query = db.updateTable(table as any)
            .set({ updated_at: new Date().toISOString() })
            .where("run_id", "=", message.runId)
            .where("r2_key", "=", message.r2Key);
          
          if (message.jobType === "simulation-batch" && (message as any).batchIndex !== undefined) {
             await (query as any).where("batch_index", "=", (message as any).batchIndex).execute();
          } else {
             await query.execute();
          }
        };

        await executePhase(phaseDef, message.r2Key, strategies, pipelineContext);

        // Record completion for the document/phase
        await db.updateTable("simulation_run_documents")
          .set({
             processed_phases_json: sql`json_insert(processed_phases_json, '$[#]', ${phaseName})`,
             updated_at: new Date().toISOString()
          } as any)
          .where("run_id", "=", message.runId)
          .where("r2_key", "=", message.r2Key)
          .where(sql`json_extract(processed_phases_json, '$')`, "not like", `%${phaseName}%`)
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

