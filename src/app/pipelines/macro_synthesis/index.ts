import { registerPipeline } from "../../engine/simulation/registry";
import { runPhaseMacroSynthesis } from "./engine/simulation/runner";
import { recoverMacroSynthesisZombies } from "./engine/simulation/sweeper";
import { macroSynthesisRoutes } from "./web/routes/outputs";
import { MacroOutputsCard } from "./web/ui/MacroOutputsCard";

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
  recoverZombies: recoverMacroSynthesisZombies,
});
