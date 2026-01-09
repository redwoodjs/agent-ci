"use client";

import { useState } from "react";

type SourceType =
  | "GitHub PR"
  | "GitHub Issue"
  | "Release"
  | "Discord"
  | "Cursor"
  | "Unknown";

interface TimelineEvent {
  id: string;
  title: string;
  summary: string;
  createdAt: string | null;
  documentId: string | null;
  sourceType: SourceType;
  source: string;
  url: string | null;
  event: string;
  impact: string;
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
      return (
        <svg
          className={className}
          fill="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
      );
    case "Discord":
      return (
        <svg
          className={className}
          fill="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      );
    case "Cursor":
      return (
        <svg
          className={className}
          fill="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
        </svg>
      );
    default:
      return null;
  }
};

interface TimelineItemProps {
  event: TimelineEvent;
  isLast: boolean;
  fileName: string;
}

const TimelineItem = ({ event, isLast, fileName }: TimelineItemProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const colorClasses = getSourceColor(event.sourceType);
  const date = event.createdAt ? new Date(event.createdAt) : null;

  const Badge = () => {
    const content = (
      <span
        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border uppercase tracking-wider mono transition-all ${colorClasses} ${
          event.url
            ? "hover:shadow-sm hover:scale-105 active:scale-95"
            : ""
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
          onClick={(e) => e.stopPropagation()}
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
            {date && (
              <span className="text-xs font-medium text-slate-400 mono">
                {date.toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "2-digit",
                })}
              </span>
            )}
          </div>
          <span className="text-[10px] text-slate-300 group-hover/card:text-slate-500 transition-colors">
            {isExpanded ? "Collapse" : "Expand"}
          </span>
        </div>

        <h3 className="text-sm font-semibold text-slate-800 leading-snug break-words">
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
            <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded border border-slate-100 break-words">
              {event.impact}
            </p>
            <div className="mt-2 text-[10px] text-slate-400 mono italic flex items-center justify-between">
              {event.createdAt && (
                <span>Logged: {new Date(event.createdAt).toLocaleString()}</span>
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
          key={event.id || idx}
          event={event}
          isLast={idx === events.length - 1}
          fileName={fileName}
        />
      ))}
    </div>
  );
}
