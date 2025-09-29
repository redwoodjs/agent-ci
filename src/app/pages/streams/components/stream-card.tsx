"use client";

import { MoreHorizontal, Clock, Github } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { ActivityGraph } from "./activity-graph";
import { AppDatabase } from "@/db";

export function StreamCard({ stream }: { stream: AppDatabase["streams"] }) {
  return (
    <Card
      className="p-6 hover:bg-gray-50 cursor-pointer transition-colors border border-gray-200"
      style={{ pointerEvents: "auto" }}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h3>
              <a href={`/streams/${stream.id}/ask`}>{stream.name}</a>
            </h3>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-6 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <span>{Math.min(stream.sources.length, 5)} sources</span>
              </div>
              <div className="flex items-center gap-1">
                <span>{stream.subjects.length} subject(s)</span>
              </div>
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <span>Updated {stream.updatedAt}</span>
              </div>
            </div>

            <ActivityGraph
              activity={[0.5, 0, 0, 0.5, 0, 0, 0]}
              eventsCount={2}
            />
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            // Handle more actions menu here
          }}
        >
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      </div>
    </Card>
  );
}
