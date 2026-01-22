import { registerPipeline } from "../../engine/simulation/registry";
import { runPhaseMacroClassification } from "./engine/simulation/runner";
import { macroClassificationRoutes } from "./web/routes/classifications";
import { MacroClassificationsCard } from "./web/ui/MacroClassificationsCard";

registerPipeline({
  phase: "macro_classification",
  label: "Macro Classification",
  runner: runPhaseMacroClassification,
  web: {
    routes: macroClassificationRoutes,
    ui: {
      drilldown: MacroClassificationsCard,
    },
  },
  recoverZombies: async () => {},
});
