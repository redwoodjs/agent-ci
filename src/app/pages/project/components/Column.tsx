"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Card } from "./Card";
import { LaneSettings } from "./LaneSettings";

export function Column({
  lane,
  tasks,
  className,
}: {
  lane: any;
  tasks: any;
  className: string;
}) {
  const [showSettings, setShowSettings] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className={className}>
      <div className="flex gap-2 items-center mb-2">
        <div className="text-md font-mono font-bold text-orange-500 flex-1">
          {lane.name}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowSettings(true)}
          title="Lane settings"
        >
          ⚙️
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            console.log("clicked");
          }}
        >
          +
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {tasks.map((task: any) => (
          <Card key={task.id} task={task} />
        ))}
      </div>
      
      {showSettings && (
        <LaneSettings
          lane={lane}
          onClose={() => setShowSettings(false)}
          onUpdate={() => {
            setRefreshKey(prev => prev + 1);
            // This will trigger a re-render, though in a real app you'd want to update the parent state
          }}
        />
      )}
    </div>
  );
}
