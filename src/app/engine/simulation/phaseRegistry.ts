export const simulationRunViews = [
  { id: "documents", label: "Documents" },
  { id: "micro-batches", label: "Micro batches" },
  { id: "macro-outputs", label: "Macro outputs" },
  { id: "macro-classifications", label: "Macro classifications" },
  { id: "materialized-moments", label: "Materialized moments" },
  { id: "link-decisions", label: "Link decisions" },
  { id: "candidate-sets", label: "Candidate sets" },
  { id: "timeline-fit-decisions", label: "Timeline fit decisions" },
] as const;

export type SimulationRunViewId = (typeof simulationRunViews)[number]["id"];

