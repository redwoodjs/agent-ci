import type { SimulationDbContext } from "./types";
import type { SimulationPhase } from "./types";

export type WorkUnit =
  | { kind: "document"; r2Key: string }
  | { kind: "batch"; r2Key: string; batchIndex: number }
  | { kind: "custom"; payload: any };

export type PipelineRegistryEntry = {
  phase: SimulationPhase;
  label: string;
  // SUPERVISOR context: Called by the heartbeat to poll/dispatch work or advance phase
  onTick: (
    context: SimulationDbContext,
    input: { runId: string; phaseIdx: number }
  ) => Promise<{ status: string; currentPhase: string } | null>;
  // HANDLER context: Called by the queue worker to process a specific WorkUnit
  onExecute: (
    context: SimulationDbContext,
    input: { runId: string; workUnit: WorkUnit }
  ) => Promise<void>;
  web?: {
    routes?: any[];
    ui?: {
      summary?: React.ComponentType<{ runId: string; progress: any }>;
      drilldown?: React.ComponentType<{ runId: string; effectiveNamespace: string | null }>;
    };
  };
  recoverZombies: (
    context: SimulationDbContext,
    input: { runId: string }
  ) => Promise<void>;
};

export const pipelineRegistry: Record<SimulationPhase, PipelineRegistryEntry> = {} as any;

export function registerPipeline(entry: PipelineRegistryEntry) {
  pipelineRegistry[entry.phase] = entry;
}


export const simulationPhasesOrdered = [
  "r2_listing",
  "ingest_diff",
  "micro_batches",
  "macro_synthesis",
  "macro_classification",
  "materialize_moments",
  "deterministic_linking",
  "candidate_sets",
  "timeline_fit",
] as const satisfies ReadonlyArray<SimulationPhase>;
