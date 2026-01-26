import { registerPipeline } from "../../engine/simulation/registry";
import { runPhaseTimelineFit } from "./engine/simulation/runner";
import { timelineFitRoutes } from "./web/routes/timeline-fit";
import { TimelineFitDecisionsCard } from "./web/ui/TimelineFitDecisionsCard";
import { recoverZombiesForPhase } from "../../engine/simulation/resiliency";

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
  recoverZombies: (context, input) => recoverZombiesForPhase(context, { ...input, phase: "timeline_fit" }),
});
