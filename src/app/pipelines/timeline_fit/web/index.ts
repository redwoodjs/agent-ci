import { registerPipeline } from "../../../engine/simulation/registry";
import { runPhaseTimelineFit } from "../engine/simulation/runner";
import { timelineFitRoutes } from "./routes/timeline-fit";
import { TimelineFitDecisionsCard } from "./ui/TimelineFitDecisionsCard";

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
});
