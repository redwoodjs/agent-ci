"use client";

import { useEffect, useRef, useState } from "react";
import { dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { Button } from "@/app/components/ui/button";
import { Card } from "./Card";
import { LaneSettings } from "./LaneSettings";
import { AddTaskForm } from "./AddTaskForm";
import { AppDatabase } from "@/db";



// Types
interface TaskItem {
  id: string;
  name: string;
}

interface Lane {
  id: string;
  name: string;
  tasks: TaskItem[];
}

export function Column({
  lane,
  tasks,
  className,
  projectId,
  onCardDropped,
}: {
    lane: Lane;
  tasks: TaskItem[];
  className: string;
  projectId: string;
  onCardDropped: (args: { cardId: string; fromLaneId: string; toLaneId: string; index?: number }) => void;
}) {
  const [showSettings, setShowSettings] = useState(false);
  const [showAddTaskForm, setShowAddTaskForm] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const laneRef = useRef<HTMLDivElement | null>(null);
  const [isOver, setIsOver] = useState(false);

  useEffect(() => {
    if (!laneRef.current) return;

    const cleanup = combine(
      dropTargetForElements({
        element: laneRef.current,
        getData: () => ({ type: "lane", laneId: lane.id }),
        onDragEnter() {
          setIsOver(true);
        },
        onDragLeave() {
          setIsOver(false);
        },
        onDrop({ source }) {
          setIsOver(false);
          const data: { type: string; cardId: string; fromLaneId: string; toLaneId: string; index?: number } = source.data as unknown as { type: string; cardId: string; fromLaneId: string; toLaneId: string; index?: number };
          if (data?.type === "card") {
            onCardDropped({ cardId: data.cardId, fromLaneId: data.fromLaneId, toLaneId: lane.id });
          }
        },
      })
    );

    return cleanup;
  }, [lane.id, onCardDropped]);

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
          onClick={() => setShowAddTaskForm(true)}
        >
          +
        </Button>
      </div>
      <div ref={laneRef}
        role="list"
        aria-label={`${lane.name} lane`}
        className={`flex flex-col gap-2 min-h-[200px] rounded-3xl border p-3 flex flex-col gap-3 transition ${
          isOver ? "ring-2 ring-blue-500 bg-blue-50" : ""
        }`}>
        {tasks.map((task: TaskItem, index: number) => (
          <Card
            key={task.id}
            task={task as unknown as AppDatabase["tasks"]}
            laneId={lane.id as unknown as string}
            onCardDropped={onCardDropped}
            taskIndex={index}
          />
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
      
      {showAddTaskForm && (
        <AddTaskForm 
          projectId={projectId} 
          isOpen={true}
          onClose={() => setShowAddTaskForm(false)}
        />
      )}
    </div>
  );
}
