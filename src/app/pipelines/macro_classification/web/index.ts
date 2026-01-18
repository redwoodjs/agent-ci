import { registerPipeline } from "../../../engine/simulation/registry";
import { runPhaseMacroClassification } from "../engine/simulation/runner";
import { macroClassificationRoutes } from "./routes/classifications";
import { MacroClassificationsCard } from "./ui/MacroClassificationsCard";

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
});
