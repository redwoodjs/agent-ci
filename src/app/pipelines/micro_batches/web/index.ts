import { registerPipeline } from "../../../engine/simulation/registry";
import { runPhaseMicroBatches } from "../engine/simulation/runner";
import { microBatchesRoutes } from "./routes/batches";
import { MicroBatchesCard } from "./ui/MicroBatchesCard";

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
});
