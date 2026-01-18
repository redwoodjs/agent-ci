import { registerPipeline } from "../../../engine/simulation/registry";
import { runPhaseCandidateSets } from "../engine/simulation/runner";
import { candidateSetsRoutes } from "./routes/candidate-sets";
import { CandidateSetsCard } from "./ui/CandidateSetsCard";

registerPipeline({
  phase: "candidate_sets",
  label: "Candidate Sets",
  runner: runPhaseCandidateSets,
  web: {
    routes: candidateSetsRoutes,
    ui: {
      drilldown: CandidateSetsCard,
    },
  },
});
