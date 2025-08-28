"use client";

import { Button } from "@/app/components/ui/button";
import { Card } from "./Card";

export function Column({
  lane,
  tasks,
  className,
}: {
  lane: any;
  tasks: any;
  className: string;
}) {
  return (
    <div className={className}>
      <div className="flex gap-2 items-center mb-2">
        <div className="text-md font-mono font-bold text-orange-500 flex-1">
          {lane.name}
        </div>
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
    </div>
  );
}
