"use client";

import React, { useState } from "react";
import { GithubIcon, DiscordIcon, CursorIcon } from "./Icons";

type SourceType =
  | "GitHub PR"
  | "GitHub Issue"
  | "Release"
  | "Discord"
  | "Cursor"
  | "Unknown";

interface TimelineEvent {
  sourceType: SourceType;
  source: string;
  url: string | null;
  event: string;
  impact: string;
  timestamp?: string;
  createdAt?: string | null;
}

interface TimelineSectionProps {
  events: TimelineEvent[];
  fileName: string;
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

const SourceIcon = ({
  type,
  className,
}: {
  type: SourceType;
  className?: string;
}) => {
  switch (type) {
    case "GitHub PR":
    case "GitHub Issue":
    case "Release":
      return <GithubIcon className={className} />;
    case "Discord":
      return <DiscordIcon className={className} />;
    case "Cursor":
      return <CursorIcon className={className} />;
    default:
      return null;
  }
};

interface TimelineItemProps {
  event: TimelineEvent;
  isLast: boolean;
  fileName: string;
}

const TimelineItem: React.FC<TimelineItemProps> = ({
  event,
  isLast,
  fileName,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const colorClasses = getSourceColor(event.sourceType);
  // Use createdAt if available, otherwise fall back to timestamp
  const timestampValue = event.createdAt || event.timestamp;
  const date = timestampValue ? new Date(timestampValue) : null;

  const Badge = () => {
    const content = (
      <span
        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border uppercase tracking-wider mono transition-all ${colorClasses} ${
          event.url ? "hover:shadow-sm hover:scale-105 active:scale-95" : ""
        }`}
      >
        {event.source}
      </span>
    );

    if (event.url) {
      return (
        <a
          href={event.url}
          target="_blank"
          rel="noopener noreferrer"
          title="View Source"
          className="inline-flex"
          onClick={(e) => e.stopPropagation()} // Prevent card expansion
        >
          {content}
        </a>
      );
    }
    return content;
  };

  return (
    <div className="relative pl-8 pb-6 group">
      {!isLast && (
        <div className="absolute left-[11px] top-6 bottom-0 w-px bg-slate-200 group-hover:bg-slate-300 transition-colors" />
      )}

      <div
        className={`absolute left-0 top-1.5 w-6 h-6 rounded-full border-2 border-white shadow-sm flex items-center justify-center z-10 ${
          colorClasses.split(" ")[1]
        }`}
      >
        <SourceIcon
          type={event.sourceType}
          className={`w-3.5 h-3.5 ${colorClasses.split(" ")[0]}`}
        />
      </div>

      <div
        className="bg-white border border-slate-200 rounded-lg p-3 hover:border-slate-300 transition-all hover:shadow-md cursor-pointer group/card"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-start justify-between mb-1">
          <div className="flex items-center gap-2">
            <Badge />
            {date && !isNaN(date.getTime()) ? (
              <span className="text-xs font-medium text-slate-400 mono">
                {date.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "2-digit",
                })}
              </span>
            ) : (
              <span className="text-xs font-medium text-slate-400 mono italic">
                No date
              </span>
            )}
          </div>
          <span className="text-[10px] text-slate-300 group-hover/card:text-slate-500 transition-colors">
            {isExpanded ? "Collapse" : "Expand"}
          </span>
        </div>

        <h3 className="text-sm font-semibold text-slate-800 leading-snug">
          {event.event}
        </h3>

        {isExpanded && (
          <div className="mt-3 pt-3 border-t border-slate-100 animate-in fade-in slide-in-from-top-1 duration-200">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-tight mb-2 flex items-center gap-1.5">
              Impact on{" "}
              <code className="bg-slate-100 px-1.5 py-0.5 rounded text-indigo-600 mono normal-case font-medium border border-slate-200/50">
                {fileName}
              </code>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded border border-slate-100">
              {event.impact}
            </p>
            <div className="mt-2 text-[10px] text-slate-400 mono italic flex items-center justify-between">
              {timestampValue && (
                <span>
                  Logged:{" "}
                  {date && !isNaN(date.getTime())
                    ? date.toLocaleString()
                    : timestampValue}
                </span>
              )}
              {event.url && (
                <a
                  href={event.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-500 hover:underline flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  View Original Source
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
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export function TimelineSection({ events, fileName }: TimelineSectionProps) {
  if (!events || events.length === 0) {
    return (
      <p className="text-gray-500 italic text-center py-8">
        No development events found in the timeline.
      </p>
    );
  }

  return (
    <div className="relative">
      {events.map((event, idx) => (
        <TimelineItem
          key={idx}
          event={event}
          isLast={idx === events.length - 1}
          fileName={fileName}
        />
      ))}
    </div>
  );
}
