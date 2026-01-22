import { registerPipeline } from "../../engine/simulation/registry";
import { runPhaseIngestDiff } from "./engine/simulation/runner";
import { ingestDiffRoutes } from "./web/routes/documents";
import { DocumentsCard } from "./web/ui/DocumentsCard";

registerPipeline({
  phase: "ingest_diff",
  label: "Ingest & Diff",
  runner: runPhaseIngestDiff,
  web: {
    routes: ingestDiffRoutes,
    ui: {
      drilldown: DocumentsCard,
    },
  },
  recoverZombies: async () => {},
});
