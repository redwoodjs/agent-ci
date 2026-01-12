"use client";

import React, { useState } from "react";
import { SourceIcon } from "./icons";
import { SourceType } from "./types";

interface EvolutionDataItem {
  date: string;
  sourceType: SourceType;
  source: string;
  url: string | null;
  event: string;
  impact: string;
}

interface EvolutionTableProps {
  data: EvolutionDataItem[];
  functionName: string;
  view?: "table" | "timeline";
}

type ViewType = "table" | "timeline";

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

function TableView({
  data,
  functionName,
}: {
  data: EvolutionDataItem[];
  functionName: string;
}) {
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-slate-50/50 border-b border-slate-200">
            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter w-24">
              Date
            </th>
            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter w-32">
              Source
            </th>
            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
              Event
            </th>
            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter w-12"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.map((item, idx) => {
            const isExpanded = expandedRow === idx;
            const colorClasses = getSourceColor(item.sourceType);
            const BadgeContent = (
              <div
                className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2 py-0.5 rounded border mono uppercase shadow-sm ${colorClasses} ${
                  item.url
                    ? "hover:scale-105 hover:shadow-sm active:scale-95"
                    : ""
                }`}
              >
                <SourceIcon type={item.sourceType} className="w-3 h-3" />
                {item.source}
              </div>
            );

            return (
              <React.Fragment key={idx}>
                <tr
                  className={`group cursor-pointer transition-colors ${
                    isExpanded ? "bg-indigo-50/30" : "hover:bg-slate-50"
                  }`}
                  onClick={() => setExpandedRow(isExpanded ? null : idx)}
                >
                  <td className="px-6 py-4 text-[11px] font-medium text-slate-500 mono whitespace-nowrap">
                    {item.date}
                  </td>
                  <td className="px-6 py-4">
                    {item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="View Source"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {BadgeContent}
                      </a>
                    ) : (
                      BadgeContent
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <p className="text-xs font-medium text-slate-800 leading-tight max-w-lg">
                      {item.event}
                    </p>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <svg
                      className={`w-4 h-4 text-slate-300 transition-transform duration-200 ${
                        isExpanded ? "rotate-180" : ""
                      }`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="bg-indigo-50/20">
                    <td colSpan={4} className="px-6 py-4 animate-in fade-in slide-in-from-top-1">
                      <div className="pl-6 border-l-2 border-indigo-200 py-2">
                        <p className="text-xs text-slate-600 leading-relaxed mb-3">
                          {item.impact}
                        </p>
                        {item.url && (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] font-bold text-indigo-500 hover:text-indigo-600 uppercase tracking-widest flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            View Citation
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
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TimelineView({
  data,
  functionName,
}: {
  data: EvolutionDataItem[];
  functionName: string;
}) {
  // Convert date string to timestamp for timeline view
  // We'll use the date string as-is and parse it when needed
  const timelineData = data.map((item) => {
    // Try to parse the date string to get a timestamp
    // Date format is typically "MMM DD, YYYY" or similar
    const date = new Date(item.date);
    const timestamp = isNaN(date.getTime())
      ? new Date().toISOString()
      : date.toISOString();
    return {
      ...item,
      timestamp,
    };
  });

  return (
    <div className="px-6 py-4">
      {timelineData.map((event, idx) => {
        const isLast = idx === timelineData.length - 1;
        return (
          <TimelineItem
            key={idx}
            event={event}
            isLast={isLast}
            functionName={functionName}
          />
        );
      })}
    </div>
  );
}

function TimelineItem({
  event,
  isLast,
  functionName,
}: {
  event: EvolutionDataItem & { timestamp: string };
  isLast: boolean;
  functionName: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const colorClasses = getSourceColor(event.sourceType);
  const date = new Date(event.timestamp);

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
            <span className="text-xs font-medium text-slate-400 mono">
              {date.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "2-digit",
              })}
            </span>
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
                {functionName}
              </code>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 p-2.5 rounded border border-slate-100">
              {event.impact}
            </p>
            <div className="mt-2 text-[10px] text-slate-400 mono italic flex items-center justify-between">
              <span>Date: {event.date}</span>
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
}

export function EvolutionTable({
  data,
  functionName,
  view: initialView = "timeline",
}: EvolutionTableProps) {
  const [view, setView] = useState<ViewType>(initialView);

  return (
    <>
      <div className="bg-slate-50 border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
          Evolution
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView("table")}
            className={`text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded transition-colors ${
              view === "table"
                ? "bg-indigo-500 text-white"
                : "bg-white text-slate-500 hover:bg-slate-100 border border-slate-200"
            }`}
          >
            Table
          </button>
          <button
            onClick={() => setView("timeline")}
            className={`text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded transition-colors ${
              view === "timeline"
                ? "bg-indigo-500 text-white"
                : "bg-white text-slate-500 hover:bg-slate-100 border border-slate-200"
            }`}
          >
            Timeline
          </button>
        </div>
      </div>
      {view === "table" ? (
        <TableView data={data} functionName={functionName} />
      ) : (
        <TimelineView data={data} functionName={functionName} />
      )}
    </>
  );
}
