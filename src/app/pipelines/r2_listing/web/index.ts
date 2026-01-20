import { registerPipeline } from "../../../engine/simulation/registry";
import { runPhaseR2Listing } from "../engine/simulation/runner";

registerPipeline({
  phase: "r2_listing",
  label: "R2 Listing",
  runner: runPhaseR2Listing,
});
