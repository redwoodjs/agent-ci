"use client";

import { useMemo, useEffect, useRef } from "react";
import { MomentDay } from "./types";
import { groupIntoWeeks, compressWeeks, getMonthLabels } from "./date-helpers";
import ContributionCell from "./contribution-cell";

interface Props {
  data: MomentDay[];
  compressThreshold?: number;
  selectedDate?: string | null;
  onDateClick?: (date: string) => void;
}

const Heatmap: React.FC<Props> = ({
  data,
  compressThreshold = 2,
  selectedDate = null,
  onDateClick,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const totalMoments = data.reduce((acc, curr) => acc + curr.count, 0);

  // Process data: Group -> Compress -> Truncate Trailing
  const weeks = useMemo(() => {
    const rawWeeks = groupIntoWeeks(data);
    return compressWeeks(rawWeeks, compressThreshold);
  }, [data, compressThreshold]);

  const monthLabels = useMemo(() => getMonthLabels(weeks), [weeks]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollLeft =
          scrollContainerRef.current.scrollWidth;
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [weeks]);

  if (totalMoments === 0 || weeks.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-12 shadow-sm text-center">
        <p className="text-gray-400 font-medium italic">
          No activity recorded for this period.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col bg-white border border-gray-200 rounded-lg p-6 shadow-sm overflow-hidden">
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-xl font-bold text-gray-900">
          {totalMoments.toLocaleString()} moments
        </h3>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span>Less</span>
          <div className="flex gap-[2px]">
            <div className="w-3 h-3 rounded-sm bg-gray-100" />
            <div className="w-3 h-3 rounded-sm bg-green-200" />
            <div className="w-3 h-3 rounded-sm bg-green-400" />
            <div className="w-3 h-3 rounded-sm bg-green-600" />
            <div className="w-3 h-3 rounded-sm bg-green-800" />
          </div>
          <span>More</span>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className="relative overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent scroll-smooth"
      >
        <div className="flex gap-[3px] min-w-max">
          {/* Day Labels */}
          <div className="flex flex-col gap-[3px] pr-3 text-[10px] text-gray-300 select-none pt-4">
            <div className="h-3 flex items-center">Mon</div>
            <div className="h-3 flex items-center" />
            <div className="h-3 flex items-center">Wed</div>
            <div className="h-3 flex items-center" />
            <div className="h-3 flex items-center">Fri</div>
            <div className="h-3 flex items-center" />
            <div className="h-3 flex items-center" />
          </div>

          <div className="flex flex-col gap-[3px]">
            {/* Header Row (Month Labels) */}
            <div className="h-4 relative mb-1">
              {monthLabels.map((m, idx) => (
                <div
                  key={`${m.label}-${idx}`}
                  className="absolute text-[10px] text-gray-400 font-semibold whitespace-nowrap"
                  style={{ left: `${m.index * 15}px` }}
                >
                  {m.label}
                </div>
              ))}
            </div>

            {/* Grid Area */}
            <div className="flex gap-[3px]">
              {weeks.map((week, weekIdx) => (
                <div
                  key={weekIdx}
                  className="flex flex-col gap-[3px] relative group"
                >
                  {week.days.map((day, dayIdx) => (
                    <ContributionCell
                      key={dayIdx}
                      day={day}
                      isGap={week.isGap}
                      isSelected={selectedDate === day.date}
                      onClick={() => onDateClick?.(day.date)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-gray-100 flex justify-between items-center text-[11px] text-gray-400 italic">
        <span>Timeline ends strictly at last recorded activity.</span>
      </div>
    </div>
  );
};

export default Heatmap;
