"use client";
import { useMemo, useState } from "react";
import { Column } from "./Column";
import { Lane, TaskItem } from "./Board";
import { persistLaneOrders } from "@/app/services/lanes";

// Helper functions
function getCard(lanes: any[], taskId: string): any | undefined {
  for (const lane of lanes) {
    const found = lane.tasks.find((t: TaskItem) => t.id === taskId);
    if (found) return found;
  }
}

function removeFromLane(lanes: any[], laneId: string, taskId: string): any[] {
  return lanes.map((lane) =>
    lane.id === laneId
      ? { ...lane, tasks: lane.tasks.filter((t: TaskItem) => t.id !== taskId) }
      : lane
  );
}

function addToLane(lanes: Lane[], laneId: string, card: TaskItem, index?: number) {
    const next = lanes.map((l) => ({ ...l, tasks: [...l.tasks] }));
    const to = next.find((l) => l.id === laneId);
    if (!to) return next;
    if (typeof index === "number" && index >= 0) {
      to.tasks.splice(index, 0, card);
    } else {
      to.tasks.push(card);
    }
    return next;
  }

function moveWithinLane(lanes: Lane[], laneId: string, cardId: string, toIndex: number) {
    const next = lanes.map((l) => ({ ...l, tasks: [...l.tasks] }));
    const lane = next.find((l) => l.id === laneId);
    if (!lane) return next;
    const fromIndex = lane.tasks.findIndex((c) => c.id === cardId);
    if (fromIndex === -1) return next;
  
    // no-op if dropped onto itself
    if (fromIndex === toIndex || fromIndex === toIndex - 1) {
      return next;
    }

    const [card] = lane.tasks.splice(fromIndex, 1);
    const finalIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
    lane.tasks.splice(finalIndex, 0, card);
    return next;
  }

export default function ColumnWrapper({
  lanes:initialLanes,
  projectId,
}: {
  lanes: any[];
  projectId: string;

}) {
    const [lanes, setLanes] = useState(initialLanes);
    const handleCardDropped = useMemo(
  () =>
    ({
      cardId,
      fromLaneId,
      toLaneId,
      index,
    }: {
      cardId: string;
      fromLaneId: string;
      toLaneId: string;
      index?: number;
    }) => {
      setLanes((prev) => {
        const card = getCard(prev, cardId);
        if (!card) return prev;

        // Reorder within same lane
        if (fromLaneId === toLaneId) {
          // Ignore container-level drops (no index). Only handle precise reorders.
          if (typeof index === "number") {
            const next = moveWithinLane(prev, toLaneId, cardId, index);
            // fire and forget
            void persistLaneOrders(projectId, next.map((l) => ({ laneId: l.id, orderedTaskIds: l.tasks.map((t: TaskItem) => t.id) })));
            return next;
          }
          return prev;
        }

        // Move across lanes (to end or a specific position)
        const targetLane = prev.find((l) => l.id === toLaneId);
        const alreadyInTarget = !!targetLane?.tasks.some((t: TaskItem) => t.id === cardId);

        // If a more specific card-level drop already moved the card, skip adding again
        if (alreadyInTarget) {
          return removeFromLane(prev, fromLaneId, cardId);
        }

        let next = removeFromLane(prev, fromLaneId, cardId);
        next = addToLane(next, toLaneId, card, index);
        // fire and forget
        void persistLaneOrders(projectId, next.map((l) => ({ laneId: l.id, orderedTaskIds: l.tasks.map((t: TaskItem) => t.id) })));
        return next;
      });
    },
  []
);

  return (
    <div className="flex flex-row overflow-x-auto w-full">
      {lanes.map((lane) => (
        <Column
          key={"lane-" + lane.id}
          lane={lane}
          tasks={lane.tasks}
          className="flex-1"
          projectId={projectId}
          onCardDropped={handleCardDropped}
        />
      ))}
    </div>
  );
}
