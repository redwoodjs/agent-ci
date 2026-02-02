import { registerPipeline } from "../../engine/simulation/registry";
import { executePhase } from "../../engine/runtime/orchestrator";
import { ArtifactStorage, QueueTransition } from "../../engine/runtime/strategies/simulation";
import { MicroBatchesPhase } from "./phase";
import { getSimulationDb } from "../../engine/simulation/db";
import { createDb } from "rwsdk/db";
import { qualifyName } from "../../engine/momentGraphNamespace";
import { PipelineContext } from "../../engine/runtime/types";
import { callLLM } from "../../engine/utils/llm";
import * as plugins from "../../engine/plugins/index";

const allPlugins = Object.values(plugins).filter((p: any) => typeof p === "object" && typeof p.name === "string");

registerPipeline({
  phase: "micro_batches",
  label: "Micro Batches (Unified)",
  onTick: async (ctx, { runId }) => {
    // For legacy compat, we might need polling here if Phase 1 does not queue.
    // Assuming we test by manual queuing for now.
    return { status: "running", currentPhase: "micro_batches" };
  },
  onExecute: async (ctx, { runId, workUnit }) => {
    if (workUnit.kind === "document") {
      const simDb = getSimulationDb(ctx);
      const db = createDb(ctx.env.MOMENT_GRAPH_DO as any, qualifyName("moment-graph-v2", ctx.momentGraphNamespace)) as any;
      
      const pipelineContext: PipelineContext = {
        env: ctx.env,
        r2Key: workUnit.r2Key,
        momentGraphNamespace: ctx.momentGraphNamespace,
        indexingMode: "indexing",
        db,
        vector: ctx.env.MOMENT_INDEX as unknown as any,
        llm: { call: callLLM },
        cache: {
            get: async () => null,
            set: async () => {} 
        },
        plugins: allPlugins as any[]
      };

      await executePhase(
        MicroBatchesPhase,
        workUnit.r2Key,
        {
          storage: new ArtifactStorage(runId, simDb as any),
          transition: new QueueTransition((ctx.env as any).SIMULATION_QUEUE, runId),
        },
        pipelineContext
      );
    }
  },
  recoverZombies: async () => {},
});
