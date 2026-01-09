"use client";

import React from "react";

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
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {decisions.map((d) => (
        <div
          key={d.id}
          className="bg-white border border-slate-200 rounded-xl p-4 hover:border-indigo-200 transition-all hover:shadow-lg flex flex-col h-full"
        >
          <div className="mb-3">
            <h4 className="text-[11px] font-bold text-indigo-500 uppercase tracking-widest mb-1">
              Problem / Need
            </h4>
            <p className="text-sm font-bold text-slate-900 leading-tight">
              {d.problem}
            </p>
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <h5 className="text-[10px] font-semibold text-slate-400 uppercase tracking-tighter mb-1">
                Triggering Event
              </h5>
              <p className="text-[11px] text-slate-600 italic bg-slate-50 px-2 py-1 rounded inline-block">
                {d.trigger}
              </p>
            </div>
            <div className="pt-2 border-t border-slate-50">
              <h5 className="text-[10px] font-bold text-slate-700 uppercase tracking-tighter mb-1">
                Resulting Code Change
              </h5>
              <p className="text-xs text-slate-700 leading-normal">{d.result}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
