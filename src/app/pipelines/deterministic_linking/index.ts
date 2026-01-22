import { registerPipeline } from "../../engine/simulation/registry";
import { runPhaseDeterministicLinking } from "./engine/simulation/runner";
import { deterministicLinkingRoutes } from "./web/routes/link-decisions";
import { LinkDecisionsCard } from "./web/ui/LinkDecisionsCard";

registerPipeline({
  phase: "deterministic_linking",
  label: "Deterministic Linking",
  runner: runPhaseDeterministicLinking,
  web: {
    routes: deterministicLinkingRoutes,
    ui: {
      drilldown: LinkDecisionsCard,
    },
  },
  recoverZombies: async () => {},
});
