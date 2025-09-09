"use client";
import { useEffect, useRef, useState } from "react";
import { link } from "@/app/shared/links";
import type { AppDatabase } from "@/db";

import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { attachClosestEdge, extractClosestEdge, Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";

export function Card({
  task,
  laneId,
  onCardDropped,
  taskIndex,
}: {
  task: AppDatabase["tasks"];
  laneId: string;
  onCardDropped: (args: { cardId: string; fromLaneId: string; toLaneId: string; index?: number }) => void;
  taskIndex: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  useEffect(() => {
    if (!ref.current) return;

    return draggable({
      element: ref.current,
      getInitialData: () => ({
        type: "card",
        cardId: task.id,
        order: task.position,
        fromLaneId: laneId,
      }),
      onDragStart() {
        setIsDragging(true);
      },
      onDrop() {
        setIsDragging(false);
      },
    });
  }, [task.id, laneId]);

  // drop target for reordering within a lane (before/after a specific card)
  useEffect(() => {
    if (!ref.current) return;

    return dropTargetForElements({
      element: ref.current,
      getData: ({ element, input }) =>
        attachClosestEdge(
          { type: "card", laneId, cardId: task.id, targetIndex: taskIndex },
          { element, input, allowedEdges: ["top", "bottom"] }
        ),
      onDrag({ self, source }) {
        if (source.data?.type !== "card") return;
        setClosestEdge(extractClosestEdge(self.data) ?? null);
      },
      onDragLeave() {
        setClosestEdge(null);
      },
      onDrop({ self, source }) {
        setClosestEdge(null);
        const data: any = source.data;
        if (data?.type !== "card") return;

        const edge = extractClosestEdge(self.data);
        const targetIdx: number = (self.data as any).targetIndex;
        const insertIndex = edge === "top" ? targetIdx : targetIdx + 1;

        onCardDropped({
          cardId: data.cardId,
          fromLaneId: data.fromLaneId,
          toLaneId: laneId,
          index: insertIndex,
        });
      },
    });
  }, [task.id, laneId, task.position, onCardDropped]);

  return (
    <div
      ref={ref}
      className={`rounded-2xl border p-3 shadow-sm bg-white hover:shadow transition ${
        isDragging ? "opacity-70 ring-2 ring-blue-500" : ""
      } ${closestEdge === "top" ? "outline outline-2 outline-dashed outline-blue-400 -mt-1" : ""} ${
        closestEdge === "bottom" ? "outline outline-2 outline-dashed outline-blue-400 -mb-1" : ""
      }`}
      tabIndex={0}
      role="listitem"
      aria-roledescription="Draggable item"
    >
      <div className="p-1 text-background bg-orange-500 text-xs font-mono">
        {task.containerId}
      </div>
      <a href={link("/tasks/:containerId", { containerId: task.containerId })}>
        {task.name}
      </a>
    </div>
  );
}
