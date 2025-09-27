"use client";

import { MoreHorizontal, Clock, Github } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Card } from "@/app/components/ui/card";
import { ActivityGraph } from "./activity-graph";
import { Stream } from "../types";

export function StreamCard({ stream }: { stream: Stream }) {
  return (
    <Card
      className="p-6 hover:bg-accent/50 cursor-pointer transition-colors"
      style={{ pointerEvents: "auto" }}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h3>
              <a href={`/streams/${stream.id}/ask`}>{stream.name}</a>
            </h3>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Github className="w-4 h-4" />
                {stream.owner}/repo
              </div>
            </div>
          </div>
          {stream.description && (
            <p className="text-muted-foreground text-sm mb-4">
              {stream.description}
            </p>
          )}

          <div className="space-y-3">
            <div className="flex items-center gap-6 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <span>{Math.min(stream.sourceCount, 5)} sources</span>
              </div>
              <div className="flex items-center gap-1">
                <span>{stream.subjects} subjects</span>
              </div>
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <span>Updated {stream.lastUpdated}</span>
              </div>
            </div>

            <ActivityGraph
              activity={stream.weeklyActivity}
              eventsCount={stream.eventsThisWeek}
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
