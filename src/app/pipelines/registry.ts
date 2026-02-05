import { Phase } from "../engine/runtime/types";
import { IngestDiffPhase } from "./ingest_diff";
import { MicroBatchesPhase } from "./micro_batches";
import { MacroSynthesisPhase } from "./macro_synthesis";
import { MacroClassificationPhase } from "./macro_classification";
import { MaterializeMomentsPhase } from "./materialize_moments";
import { DeterministicLinkingPhase } from "./deterministic_linking";
import { CandidateSetsPhase } from "./candidate_sets";
import { TimelineFitPhase } from "./timeline_fit";

// UI Imports
import { DocumentsCard } from "./ingest_diff/web/ui/DocumentsCard";
import { MicroBatchesCard } from "./micro_batches/web/ui/MicroBatchesCard";
import { MacroOutputsCard } from "./macro_synthesis/web/ui/MacroOutputsCard";
import { MacroClassificationsCard } from "./macro_classification/web/ui/MacroClassificationsCard";
import { MaterializedMomentsCard } from "./materialize_moments/web/ui/MaterializedMomentsCard";
import { LinkDecisionsCard } from "./deterministic_linking/web/ui/LinkDecisionsCard";
import { CandidateSetsCard } from "./candidate_sets/web/ui/CandidateSetsCard";
import { TimelineFitDecisionsCard } from "./timeline_fit/web/ui/TimelineFitDecisionsCard";

// Route Imports
import { candidateSetsRoutes } from "./candidate_sets/web/routes/candidate-sets";
import { deterministicLinkingRoutes } from "./deterministic_linking/web/routes/link-decisions";
import { timelineFitRoutes } from "./timeline_fit/web/routes/timeline-fit";

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
] as const;

export type SimulationPhaseName = (typeof simulationPhasesOrdered)[number];

export const ALL_PHASES: Phase<any, any>[] = [
  IngestDiffPhase,
  MicroBatchesPhase,
  MacroSynthesisPhase,
  MacroClassificationPhase,
  MaterializeMomentsPhase,
  DeterministicLinkingPhase,
  CandidateSetsPhase,
  TimelineFitPhase,
];

export const PHASE_METADATA: Record<
  string,
  { label: string; component?: React.ComponentType<any> }
> = {
  r2_listing: { label: "R2 Listing" },
  ingest_diff: { label: "Ingest Diff", component: DocumentsCard },
  micro_batches: { label: "Micro Batches", component: MicroBatchesCard },
  macro_synthesis: { label: "Macro Synthesis", component: MacroOutputsCard },
  macro_classification: { label: "Macro Classification", component: MacroClassificationsCard },
  materialize_moments: { label: "Materialize Moments", component: MaterializedMomentsCard },
  deterministic_linking: { label: "Deterministic Linking", component: LinkDecisionsCard },
  candidate_sets: { label: "Candidate Sets", component: CandidateSetsCard },
  timeline_fit: { label: "Timeline Fit", component: TimelineFitDecisionsCard },
};

export function getPhaseByName(name: string): Phase<any, any> | null {
  return ALL_PHASES.find((p) => p.name === name) || null;
}

export function getPhaseMetadata(name: string) {
  return PHASE_METADATA[name] || { label: name };
}

export const simulationRunViews = Object.entries(PHASE_METADATA)
  .filter(([_, meta]) => !!meta.component)
  .map(([id, meta]) => ({
    id,
    label: meta.label,
    component: meta.component!,
  }));

export const simulationPipelineRoutes = [
  ...candidateSetsRoutes,
  ...deterministicLinkingRoutes,
  ...timelineFitRoutes,
];
