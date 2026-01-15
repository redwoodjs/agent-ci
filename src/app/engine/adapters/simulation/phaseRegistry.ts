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

export function isSimulationRunViewId(
  value: string | null | undefined
): value is SimulationRunViewId {
  if (!value) {
    return false;
  }
  return simulationRunViews.some((v) => v.id === value);
}

