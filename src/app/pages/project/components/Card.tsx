import type { AppDatabase } from "@/db";

export function Card({ task }: { task: AppDatabase["tasks"] }) {
  return (
    <div className="border-2 p-2">
      <div className="p-2 text-background bg-orange-500 text-sm font-bold">
        {task.name}
      </div>
      {task.updatedAt}
    </div>
  );
}
