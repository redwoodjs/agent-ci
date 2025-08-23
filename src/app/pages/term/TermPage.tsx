import { LazyTerm } from "@/app/components/LazyTerm";

export function TermPage({ params }: { params: { containerId: string } }) {
  return <LazyTerm containerId={params.containerId} />;
}
