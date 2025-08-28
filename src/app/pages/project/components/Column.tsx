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
      <div className="text-md font-mono font-bold text-orange-500">
        {lane.name}
      </div>
      <div className="flex flex-col gap-2">
        {tasks.map((task: any) => (
          <Card key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}
