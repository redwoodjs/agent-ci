import { registerPipeline } from "../../engine/simulation/registry";
import { runPhaseMaterializeMoments } from "./engine/simulation/runner";
import { materializeMomentsRoutes } from "./web/routes/moments";
import { MaterializedMomentsCard } from "./web/ui/MaterializedMomentsCard";
import { recoverZombiesForPhase } from "../../engine/simulation/resiliency";

registerPipeline({
  phase: "materialize_moments",
  label: "Materialize Moments",
  runner: runPhaseMaterializeMoments,
  web: {
    routes: materializeMomentsRoutes,
    ui: {
      drilldown: MaterializedMomentsCard,
    },
  },
  recoverZombies: (context, input) => recoverZombiesForPhase(context, { ...input, phase: "materialize_moments" }),
});
