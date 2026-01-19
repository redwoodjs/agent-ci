import { registerPipeline } from "../../../engine/simulation/registry";
import { runPhaseMacroSynthesis } from "../engine/simulation/runner";
import { macroSynthesisRoutes } from "./routes/outputs";
import { MacroOutputsCard } from "./ui/MacroOutputsCard";

registerPipeline({
  phase: "macro_synthesis",
  label: "Macro Synthesis",
  runner: runPhaseMacroSynthesis,
  web: {
    routes: macroSynthesisRoutes,
    ui: {
      drilldown: MacroOutputsCard,
    },
  },
});
