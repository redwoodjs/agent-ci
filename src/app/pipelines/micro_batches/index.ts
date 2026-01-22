import { registerPipeline } from "../../engine/simulation/registry";
import { runPhaseMicroBatches } from "./engine/simulation/runner";
import { recoverMicroBatchZombies } from "./engine/simulation/sweeper";
import { microBatchesRoutes } from "./web/routes/batches";
import { MicroBatchesCard } from "./web/ui/MicroBatchesCard";

registerPipeline({
  phase: "micro_batches",
  label: "Micro Batches",
  runner: runPhaseMicroBatches,
  web: {
    routes: microBatchesRoutes,
    ui: {
      drilldown: MicroBatchesCard,
    },
  },
  recoverZombies: recoverMicroBatchZombies,
});
