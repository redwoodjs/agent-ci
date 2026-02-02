import { registerPipeline } from "../../engine/simulation/registry";
import { executePhase } from "../../engine/runtime/orchestrator";
import { ArtifactStorage, QueueTransition } from "../../engine/runtime/strategies/simulation";
import { MacroClassificationPhase } from "./phase";
import { getSimulationDb } from "../../engine/simulation/db";
import { createDb } from "rwsdk/db";
import { qualifyName } from "../../engine/momentGraphNamespace";
import { PipelineContext } from "../../engine/runtime/types";
import { callLLM } from "../../engine/utils/llm";
import * as plugins from "../../engine/plugins/index";

const allPlugins = Object.values(plugins).filter((p: any) => typeof p === "object" && typeof p.name === "string");

registerPipeline({
  phase: "macro_classification",
  label: "Macro Classification (Unified)",
  onTick: async (ctx, { runId }) => {
     return { status: "running", currentPhase: "macro_classification" };
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
        plugins: allPlugins as any[],
        simulation: {
            runId,
            getArtifact: async (phaseName: string, key: string) => {
                const result = await simDb
                    .selectFrom("simulation_run_artifacts")
                    .select("output_json")
                    .where("run_id", "=", runId)
                    .where("phase", "=", phaseName as any)
                    .where("artifact_key", "=", key)
                    .executeTakeFirst();
                return result?.output_json ? JSON.parse(result.output_json as string) : null;
            }
        }
      };

      await executePhase(
        MacroClassificationPhase,
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
