import { registerPipeline } from "../../../engine/simulation/registry";
import { runPhaseMaterializeMoments } from "../engine/simulation/runner";
import { materializeMomentsRoutes } from "./routes/moments";
import { MaterializedMomentsCard } from "./ui/MaterializedMomentsCard";

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
});
