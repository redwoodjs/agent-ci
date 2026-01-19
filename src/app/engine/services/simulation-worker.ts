import type { SimulationQueueMessage } from "../simulation/types";
import { advanceSimulationRunPhaseNoop } from "../runners/simulation/runner";
import { pipelineRegistry, simulationPhasesOrdered } from "../simulation/registry";
import { getSimulationDb } from "../simulation/db";

export async function processSimulationJob(
  message: SimulationQueueMessage,
  env: Cloudflare.Env
): Promise<void> {
  const context = {
    env,
    momentGraphNamespace: null, // Runners will resolve from config if needed
  };

  console.log(`[simulation-worker] Received job of type: ${message.jobType}`, {
    runId: message.runId,
  });

  switch (message.jobType) {
    case "simulation-advance": {
      // Advance to the next phase (it will then enqueue docs/batches if refactored)
      // Pass deferToQueue: true so that it enqueues the NEXT attempt if it reports "running"
      await advanceSimulationRunPhaseNoop(context, {
        runId: message.runId,
        continueOnError: true,
        deferToQueue: true,
      });
      break;
    }

    case "simulation-document": {
      const db = getSimulationDb(context);
      const runRow = await db
        .selectFrom("simulation_runs")
        .select(["current_phase"])
        .where("run_id", "=", message.runId)
        .executeTakeFirst();
      
      if (!runRow || runRow.current_phase !== message.phase) {
        console.warn(`[simulation-worker] Run ${message.runId} is not in phase ${message.phase}, skipping doc ${message.r2Key}`);
        return;
      }

      const phaseIdx = (simulationPhasesOrdered as any).indexOf(message.phase);
      const entry = pipelineRegistry[message.phase];
      if (entry) {
        await entry.runner(context, {
          runId: message.runId,
          phaseIdx,
          r2Key: message.r2Key,
        });
      }
      break;
    }

    case "simulation-batch": {
      const entry = pipelineRegistry["micro_batches"];
      if (entry) {
        await entry.runner(context, {
          runId: message.runId,
          phaseIdx: (simulationPhasesOrdered as any).indexOf("micro_batches"),
          r2Key: message.r2Key,
          batchIndex: message.batchIndex,
        });
      }
      break;
    }

    default: {
      console.error(`[simulation-worker] Unknown job type: ${(message as any).jobType}`);
    }
  }
}

