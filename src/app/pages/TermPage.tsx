import { LazyTerm } from "@/app/components/Term";

export function TermPage({ params }: { params: { containerId: string } }) {
  return <LazyTerm containerId={params.containerId} />;
}
