import React from "react";
import { fetchCodeTimeline } from "./actions";

export interface Decision {
  id: string;
  problem: string;
  trigger: string;
  result: string;
}

interface DecisionGridProps {
  decisions: Decision[];
}

export const DecisionGrid: React.FC<DecisionGridProps> = ({ decisions }) => {
  if (!decisions || decisions.length === 0) {
    return (
      <p className="text-gray-500 italic text-center py-8">
        No key decisions found in the timeline.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {decisions.map((d) => (
        <div
          key={d.id}
          className="bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-indigo-200 transition-all hover:shadow-lg flex flex-col h-full"
        >
          {/* Decision/Need Section - Prominent Header */}
          <div className="bg-gradient-to-br from-indigo-50 to-purple-50 px-4 pt-4 pb-3 border-b border-indigo-100">
            <h4 className="text-[10px] font-bold text-indigo-600 uppercase tracking-widest mb-2">
              Decision / Need
            </h4>
            <p className="text-sm font-bold text-slate-900 leading-snug break-words">
              {d.problem}
            </p>
          </div>

          {/* Content Section */}
          <div className="flex-1 px-4 py-3 space-y-3 min-w-0 flex flex-col">
            <div>
              <h5 className="text-[10px] font-semibold text-slate-400 uppercase tracking-tighter mb-1.5">
                Triggering Event
              </h5>
              <p className="text-[11px] text-slate-600 italic bg-slate-50 px-2.5 py-1.5 rounded border border-slate-100 break-words">
                {d.trigger}
              </p>
            </div>
            <div className="flex-1 flex flex-col">
              <h5 className="text-[10px] font-semibold text-slate-400 uppercase tracking-tighter mb-1.5">
                Resulting Code Change
              </h5>
              <p className="text-xs text-slate-700 leading-relaxed break-words flex-1">
                {d.result}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

function getSourceLabel(
  documentId: string | null | undefined,
  sourceMetadata: any
): string {
  if (!documentId) return "Unknown";

  // Extract PR number, issue number, or release tag from documentId
  if (documentId.includes("/pull-requests/")) {
    const match = documentId.match(/\/pull-requests\/(\d+)/);
    if (match) return `PR #${match[1]}`;
  }
  if (documentId.includes("/issues/")) {
    const match = documentId.match(/\/issues\/(\d+)/);
    if (match) return `Issue #${match[1]}`;
  }
  if (documentId.includes("/releases/")) {
    const parts = documentId.split("/");
    const releasePart = parts[parts.length - 1];
    if (releasePart && releasePart !== "latest.json") {
      return releasePart.replace(".json", "");
    }
    return "Release";
  }
  if (documentId.startsWith("discord/")) {
    const parts = documentId.split("/");
    return parts[parts.length - 1]?.replace(".json", "") || "Discord";
  }
  if (documentId.startsWith("cursor/")) {
    return "Cursor";
  }

  return documentId.split("/").pop()?.replace(".json", "") || "Unknown";
}

export async function DecisionGridSection({
  repo,
  commit,
  namespace,
}: {
  repo: string;
  commit: string;
  namespace: string | null;
}) {
  const timelineResult = await fetchCodeTimeline({
    repo,
    commit,
    namespace: namespace || undefined,
  });

  if (!timelineResult.success) {
    return (
      <p className="text-red-500 italic text-center py-8">
        Error loading decisions: {timelineResult.error}
      </p>
    );
  }

  const developmentStream = (timelineResult as any).developmentStream || [];

  // Extract key decisions from high-importance moments and transform to Decision format
  const decisions: Decision[] = developmentStream
    .filter((moment: any) => moment.importance && moment.importance >= 0.8)
    .sort((a: any, b: any) => (b.importance || 0) - (a.importance || 0))
    .slice(0, 10)
    .map((moment: any) => ({
      id: moment.id || `decision-${moment.title}`,
      problem: moment.title || "Untitled",
      trigger: getSourceLabel(moment.documentId, moment.sourceMetadata),
      result: moment.summary || "No summary available.",
    }));

  return <DecisionGrid decisions={decisions} />;
}
