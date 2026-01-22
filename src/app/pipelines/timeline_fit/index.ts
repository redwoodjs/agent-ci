import { registerPipeline } from "../../engine/simulation/registry";
import { runPhaseTimelineFit } from "./engine/simulation/runner";
import { timelineFitRoutes } from "./web/routes/timeline-fit";
import { TimelineFitDecisionsCard } from "./web/ui/TimelineFitDecisionsCard";

registerPipeline({
  phase: "timeline_fit",
  label: "Timeline Fit",
  runner: runPhaseTimelineFit,
  web: {
    routes: timelineFitRoutes,
    ui: {
      drilldown: TimelineFitDecisionsCard,
    },
  },
  recoverZombies: async () => {},
});
