"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { SourceIcon, type SourceType } from "./code-tldr-page";

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
}

export function EvolutionTable({ data, functionName }: EvolutionTableProps) {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  const toggleRow = (idx: number) => {
    const newExpanded = new Set(expandedRows);
    if (newExpanded.has(idx)) {
      newExpanded.delete(idx);
    } else {
      newExpanded.add(idx);
    }
    setExpandedRows(newExpanded);
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-white border-b border-slate-100">
            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
              Date
            </th>
            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
              Source
            </th>
            <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
              Event
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {data.map((item, idx) => {
            const isExpanded = expandedRows.has(idx);
            const BadgeContent = (
              <div
                className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded border mono uppercase transition-all ${
                  item.sourceType === "GitHub PR"
                    ? "text-purple-600 bg-purple-50 border-purple-100"
                    : item.sourceType === "GitHub Issue"
                    ? "text-emerald-600 bg-emerald-50 border-emerald-100"
                    : item.sourceType === "Cursor"
                    ? "text-sky-600 bg-sky-50 border-sky-100"
                    : item.sourceType === "Release"
                    ? "text-slate-600 bg-slate-50 border-slate-200 shadow-sm"
                    : "text-slate-600 bg-slate-50 border-slate-200"
                } ${
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
                  className="hover:bg-slate-50/50 transition-colors cursor-pointer"
                  onClick={() => toggleRow(idx)}
                >
                  <td className="px-6 py-4 text-[11px] font-bold text-slate-900 mono whitespace-nowrap">
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
                  <td className="px-6 py-4 text-xs font-medium text-slate-800 leading-tight max-w-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span>{item.event}</span>
                      {isExpanded ? (
                        <ChevronUp className="w-4 h-4 text-slate-400 shrink-0 transition-colors" />
                      ) : (
                        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0 transition-colors" />
                      )}
                    </div>
                  </td>
                </tr>
                {isExpanded && (
                  <tr className="bg-slate-50/30">
                    <td colSpan={3} className="px-6 py-4">
                      <div className="border-t border-slate-100 pt-3">
                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-tight mb-2 flex items-center gap-1.5">
                          Impact on{" "}
                          <code className="mono normal-case text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded font-medium border border-indigo-200/50">
                            {functionName}
                          </code>
                        </div>
                        <p className="text-[11px] text-slate-600 leading-relaxed bg-white p-2.5 rounded border border-slate-100">
                          {item.impact}
                        </p>
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
