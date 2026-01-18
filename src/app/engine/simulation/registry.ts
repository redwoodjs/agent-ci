import type { SimulationDbContext } from "./types";
import type { SimulationPhase } from "./types";

export type PipelineRegistryEntry = {
  phase: SimulationPhase;
  label: string;
  runner: (
    context: SimulationDbContext,
    input: { runId: string; phaseIdx: number }
  ) => Promise<{ status: string; currentPhase: string } | null>;
  web?: {
    routes?: any[];
    ui?: {
      summary?: React.ComponentType<{ runId: string; progress: any }>;
      drilldown?: React.ComponentType<{ runId: string; effectiveNamespace: string | null }>;
    };
  };
};

export const pipelineRegistry: Record<SimulationPhase, PipelineRegistryEntry> = {} as any;

export function registerPipeline(entry: PipelineRegistryEntry) {
  pipelineRegistry[entry.phase] = entry;
}


export const simulationPhasesOrdered = [
  "ingest_diff",
  "micro_batches",
  "macro_synthesis",
  "macro_classification",
  "materialize_moments",
  "deterministic_linking",
  "candidate_sets",
  "timeline_fit",
] as const satisfies ReadonlyArray<SimulationPhase>;
