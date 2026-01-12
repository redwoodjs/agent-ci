import React from "react";
import { fetchCodeTimeline } from "../actions";

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
      <div className="mb-12 overflow-hidden border border-slate-200 rounded-xl bg-white shadow-sm">
        <div className="bg-slate-50 border-b border-slate-200 px-6 py-4">
          <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest relative inline-block">
            Key Decisions
            <div className="absolute -bottom-1 left-0 w-full h-1 bg-blue-500/30 rounded-full"></div>
          </h3>
        </div>
        <div className="px-6 py-8 text-center">
          <p className="text-gray-500 italic">
            No key decisions found in the timeline.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-12 overflow-hidden border border-slate-200 rounded-xl bg-white shadow-sm">
      <div className="bg-slate-50 border-b border-slate-200 px-6 py-4">
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest relative inline-block">
          Key Decisions
          <div className="absolute -bottom-1 left-0 w-full h-1 bg-blue-500/30 rounded-full"></div>
        </h3>
      </div>
      <div className="p-6">
        <div className="space-y-4">
          {decisions.map((d) => (
            <div
              key={d.id}
              className="bg-white border border-slate-200 rounded-xl overflow-hidden hover:border-indigo-200 transition-all"
            >
              <div className="grid grid-cols-1 md:grid-cols-4 gap-0">
                <div className="p-6 md:col-span-1 border-b md:border-b-0 md:border-r border-slate-100 bg-slate-50/50">
                  <h4 className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest mb-3">Problem / Need</h4>
                  <p className="text-sm font-bold text-slate-900 leading-snug">{d.problem}</p>
                  <div className="mt-4">
                    <h5 className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter mb-1">Triggering Event</h5>
                    <p className="text-[10px] text-slate-600 italic bg-white border border-slate-200 px-2 py-1 rounded inline-block">{d.trigger}</p>
                  </div>
                </div>
                <div className="p-6 md:col-span-3">
                  <h5 className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mb-3">Resulting Code Change</h5>
                  <p className="text-sm text-slate-600 leading-relaxed font-normal">{d.result}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

function getSourceLabel(
  documentId: string | null | undefined,
  sourceMetadata: any,
  createdAt: string | null | undefined
): string {
  let label = "Unknown";
  if (documentId) {
    if (documentId.includes("/pull-requests/")) {
      const match = documentId.match(/\/pull-requests\/(\d+)/);
      label = match ? `PR #${match[1]}` : "GitHub PR";
    } else if (documentId.includes("/issues/")) {
      const match = documentId.match(/\/issues\/(\d+)/);
      label = match ? `Issue #${match[1]}` : "GitHub Issue";
    } else if (documentId.includes("/releases/")) {
      const parts = documentId.split("/");
      const releasePart = parts[parts.length - 1];
      label =
        releasePart && releasePart !== "latest.json"
          ? releasePart.replace(".json", "")
          : "Release";
    } else if (documentId.startsWith("discord/")) {
      const parts = documentId.split("/");
      label = parts[parts.length - 1]?.replace(".json", "") || "Discord";
    } else if (documentId.startsWith("cursor/")) {
      label = "Cursor";
    } else {
      label = documentId.split("/").pop()?.replace(".json", "") || "Unknown";
    }
  }

  if (createdAt) {
    const date = new Date(createdAt);
    if (!isNaN(date.getTime())) {
      const dateStr = date.toISOString().split("T")[0];
      return `${label} (${dateStr})`;
    }
  }

  return label;
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
      <div className="mb-12 overflow-hidden border border-slate-200 rounded-xl bg-white shadow-sm">
        <div className="bg-slate-50 border-b border-slate-200 px-6 py-4">
          <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest relative inline-block">
            Key Decisions
            <div className="absolute -bottom-1 left-0 w-full h-1 bg-blue-500/30 rounded-full"></div>
          </h3>
        </div>
        <div className="px-6 py-8 text-center">
          <p className="text-red-500 italic">
            Error loading decisions: {timelineResult.error}
          </p>
        </div>
      </div>
    );
  }

  const developmentStream = (timelineResult as any).developmentStream || [];

  // Extract key decisions from high-importance moments and transform to Decision format
  const decisions: Decision[] = developmentStream
    .filter((moment: any) => moment.importance && moment.importance >= 0.8)
    .sort((a: any, b: any) => {
      // Sort by date (descending) so most recent important decisions are shown
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    })
    .slice(0, 6) // Limit to 6 decisions to keep the grid manageable
    .map((moment: any) => {
      // Remove [Cursor Conversation] prefix from titles since we show the icon in the trigger
      let problem = moment.title || "Untitled";
      if (moment.documentId?.startsWith("cursor/") && problem.startsWith("[Cursor Conversation]")) {
        problem = problem.replace(/^\[Cursor Conversation\]\s*/, "").trim() || "Untitled";
      }
      return {
        id: moment.id || `decision-${moment.title}`,
        problem,
        trigger: getSourceLabel(
          moment.documentId,
          moment.sourceMetadata,
          moment.createdAt
        ),
        result: moment.summary || "No summary available.",
      };
    });

  return <DecisionGrid decisions={decisions} />;
}
