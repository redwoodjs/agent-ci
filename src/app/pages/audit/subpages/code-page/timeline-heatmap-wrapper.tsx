"use client";

import { useState } from "react";
import Heatmap from "./heatmap";
import { RecentTimeline } from "./recent-timeline";
import { MomentDay } from "./types";

interface Moment {
  id: string;
  documentId: string;
  title: string;
  summary: string;
  createdAt: string | null;
  sourceMetadata?: any;
}

interface TimelineHeatmapWrapperProps {
  heatmapData: MomentDay[];
  moments: Moment[];
  repo: string;
  compressThreshold?: number;
}

export function TimelineHeatmapWrapper({
  heatmapData,
  moments,
  repo,
  compressThreshold = 2,
}: TimelineHeatmapWrapperProps) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const handleDateClick = (date: string) => {
    // Toggle selection - if clicking the same date, deselect it
    setSelectedDate(selectedDate === date ? null : date);
  };

  return (
    <>
      {/* Heatmap Visualization */}
      <div className="mb-12">
        <Heatmap
          data={heatmapData}
          compressThreshold={compressThreshold}
          selectedDate={selectedDate}
          onDateClick={handleDateClick}
        />
      </div>

      {/* Recent Timeline - 10 most recent moments */}
      <RecentTimeline
        moments={moments}
        repo={repo}
        selectedDate={selectedDate}
      />
    </>
  );
}
