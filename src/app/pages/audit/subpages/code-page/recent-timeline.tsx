"use client";

import { useState, useEffect, useRef } from "react";
import { SourceIcon } from "./icons";
import { SourceType } from "./types";

interface Moment {
  id: string;
  documentId: string;
  title: string;
  summary: string;
  createdAt: string | null;
  sourceMetadata?: any;
}

interface RecentTimelineProps {
  moments: Moment[];
  repo: string;
  selectedDate?: string | null;
}

// Helper functions (same as in index.tsx)
function getSourceTypeFromDocumentId(
  documentId: string | null | undefined
): SourceType {
  if (!documentId) return "Unknown";
  if (documentId.startsWith("github/")) {
    if (documentId.includes("/pull-requests/")) return "GitHub PR";
    if (documentId.includes("/issues/")) return "GitHub Issue";
    if (documentId.includes("/releases/")) return "Release";
    return "GitHub PR";
  }
  if (documentId.startsWith("discord/")) return "Discord";
  if (documentId.startsWith("cursor/")) return "Cursor";
  return "Unknown";
}

function getSourceLabel(
  documentId: string | null | undefined,
  sourceMetadata: any
): string {
  if (!documentId) return "Unknown";

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
    return "Discord";
  }
  if (documentId.startsWith("cursor/")) {
    return "Cursor";
  }

  return documentId.split("/").pop()?.replace(".json", "") || "Unknown";
}

function getSourceUrl(
  documentId: string | null | undefined,
  repo: string
): string | null {
  if (!documentId) return null;

  if (documentId.startsWith("cursor/") || documentId.startsWith("discord/")) {
    return `/audit/ingestion/file/${encodeURIComponent(documentId)}`;
  }

  if (documentId.includes("/pull-requests/")) {
    const match = documentId.match(/\/pull-requests\/(\d+)/);
    if (match) {
      return `https://github.com/${repo}/pull/${match[1]}`;
    }
  }
  if (documentId.includes("/issues/")) {
    const match = documentId.match(/\/issues\/(\d+)/);
    if (match) {
      return `https://github.com/${repo}/issues/${match[1]}`;
    }
  }
  if (documentId.includes("/releases/")) {
    const parts = documentId.split("/");
    const releasePart = parts[parts.length - 1]?.replace(".json", "");
    if (releasePart && releasePart !== "latest") {
      return `https://github.com/${repo}/releases/tag/${releasePart}`;
    }
  }

  return null;
}

const getSourceColor = (type: SourceType) => {
  switch (type) {
    case "GitHub PR":
      return "text-purple-600 bg-purple-50 border-purple-100";
    case "GitHub Issue":
      return "text-emerald-600 bg-emerald-50 border-emerald-100";
    case "Discord":
      return "text-indigo-600 bg-indigo-50 border-indigo-100";
    case "Cursor":
      return "text-sky-600 bg-sky-50 border-sky-100";
    case "Release":
      return "text-slate-600 bg-slate-50 border-slate-200";
    default:
      return "text-slate-600 bg-slate-50 border-slate-100";
  }
};

export function RecentTimeline({
  moments,
  repo,
  selectedDate = null,
}: RecentTimelineProps) {
  // Take the last 10 moments (most recent) and reverse for newest-first display
  const recentMoments = moments.slice(-10).reverse();

  if (recentMoments.length === 0) {
    return (
      <div className="mb-12 overflow-hidden border border-slate-200 rounded-xl bg-white shadow-sm">
        <div className="bg-slate-50 border-b border-slate-200 px-6 py-4">
          <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest relative inline-block">
            Recent Activity
            <div className="absolute -bottom-1 left-0 w-full h-1 bg-blue-500/30 rounded-full"></div>
          </h3>
        </div>
        <div className="px-6 py-8 text-center">
          <p className="text-gray-600">No recent activity available.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-12 overflow-hidden border border-slate-200 rounded-xl bg-white shadow-sm">
      <div className="bg-slate-50 border-b border-slate-200 px-6 py-4">
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest relative inline-block">
          Recent Activity
          <div className="absolute -bottom-1 left-0 w-full h-1 bg-blue-500/30 rounded-full"></div>
        </h3>
      </div>
      <div className="px-6 py-4">
        {recentMoments.map((moment, idx) => {
          const isLast = idx === recentMoments.length - 1;
          const sourceType = getSourceTypeFromDocumentId(moment.documentId);
          const source = getSourceLabel(moment.documentId, moment.sourceMetadata);
          const url = getSourceUrl(moment.documentId, repo);

          // Extract timestamp (same logic as EvolutionSection)
          const timeRange = moment.sourceMetadata?.timeRange;
          const timestamp =
            sourceType === "Cursor"
              ? moment.createdAt
              : timeRange?.start || moment.createdAt;
          const date = timestamp
            ? new Date(timestamp).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })
            : "Unknown date";

          // Convert to YYYY-MM-DD format for comparison with selectedDate
          const dateForComparison = timestamp
            ? new Date(timestamp).toISOString().split("T")[0]
            : null;
          const isHighlighted =
            selectedDate !== null && dateForComparison === selectedDate;

          // Remove [Cursor Conversation] prefix
          let event = moment.title || "Untitled";
          if (sourceType === "Cursor" && event.startsWith("[Cursor Conversation]")) {
            event = event.replace(/^\[Cursor Conversation\]\s*/, "").trim() || "Untitled";
          }

          const summary = moment.summary || "No description available.";
          const colorClasses = getSourceColor(sourceType);

          return (
            <TimelineItem
              key={moment.id || idx}
              event={event}
              summary={summary}
              date={date}
              sourceType={sourceType}
              source={source}
              url={url}
              colorClasses={colorClasses}
              isLast={isLast}
              isHighlighted={isHighlighted}
              momentId={moment.id}
            />
          );
        })}
      </div>
    </div>
  );
}

interface TimelineItemProps {
  event: string;
  summary: string;
  date: string;
  sourceType: SourceType;
  source: string;
  url: string | null;
  colorClasses: string;
  isLast: boolean;
  isHighlighted?: boolean;
  momentId: string;
}

function TimelineItem({
  event,
  summary,
  date,
  sourceType,
  source,
  url,
  colorClasses,
  isLast,
  isHighlighted = false,
  momentId,
}: TimelineItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);

  // Scroll to highlighted item when it becomes highlighted
  useEffect(() => {
    if (isHighlighted && itemRef.current) {
      itemRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [isHighlighted]);

  const Badge = () => {
    const content = (
      <div
        className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-0.5 rounded border mono uppercase shadow-sm ${colorClasses} ${
          url ? "hover:scale-105 hover:shadow-sm active:scale-95 cursor-pointer" : ""
        }`}
      >
        <SourceIcon type={sourceType} className="w-3 h-3" />
        {source}
      </div>
    );

    if (url) {
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title="View Source"
          onClick={(e) => e.stopPropagation()}
        >
          {content}
        </a>
      );
    }
    return content;
  };

  return (
    <div className="relative pl-8 pb-6 group" ref={itemRef}>
      {!isLast && (
        <div className="absolute left-[11px] top-6 bottom-0 w-px bg-slate-200 group-hover:bg-slate-300 transition-colors" />
      )}

      <div
        className={`absolute left-0 top-1.5 w-6 h-6 rounded-full border-2 border-white shadow-sm flex items-center justify-center z-10 ${
          colorClasses.split(" ")[1]
        }`}
      >
        <SourceIcon
          type={sourceType}
          className={`w-3.5 h-3.5 ${colorClasses.split(" ")[0]}`}
        />
      </div>

      <div
        className={`bg-white border rounded-lg p-3 transition-all hover:shadow-md cursor-pointer group/card ${
          isHighlighted
            ? "border-blue-500 ring-2 ring-blue-200 bg-blue-50/30"
            : "border-slate-200 hover:border-slate-300"
        }`}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-start justify-between mb-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge />
            <span className="text-xs font-medium text-slate-400 mono">
              {date}
            </span>
          </div>
          <span className="text-[10px] text-slate-300 group-hover/card:text-slate-500 transition-colors">
            {isExpanded ? "Collapse" : "Expand"}
          </span>
        </div>

        <h3 className="text-sm font-semibold text-slate-800 leading-snug">
          {event}
        </h3>

        {isExpanded && (
          <div className="mt-3 pt-3 border-t border-slate-100 animate-in fade-in slide-in-from-top-1 duration-200">
            <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded border border-slate-100">
              {summary}
            </p>
            {url && (
              <div className="mt-2">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-bold text-indigo-500 hover:text-indigo-600 uppercase tracking-widest flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  View Source
                  <svg
                    className="w-2.5 h-2.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
