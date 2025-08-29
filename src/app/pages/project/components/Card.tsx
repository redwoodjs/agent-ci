import { link } from "@/app/shared/links";
import type { AppDatabase } from "@/db";

export function Card({ task }: { task: AppDatabase["tasks"] }) {
  return (
    <div className="border-2 p-2">
      <div className="p-1 text-background bg-orange-500 text-xs font-mono">
        {task.containerId}
      </div>
      <a href={link("/tasks/:containerId", { containerId: task.containerId })}>
        {task.name}
      </a>
    </div>
  );
}
