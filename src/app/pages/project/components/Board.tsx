import { getLanesForProject, getTasksByLane } from "@/app/services/lanes";
import { Column } from "./Column";

export async function Board({ projectId }: { projectId: string }) {
  const lanes = await getLanesForProject(projectId);
  const tasks = await getTasksByLane(projectId);

  return (
    <div className="flex flex-row overflow-x-auto">
      {lanes.map((lane) => (
        <Column
          key={"lane-" + lane.id}
          lane={lane}
          tasks={tasks.filter((task) => task.laneId === lane.id)}
          className="flex-1 border-r-2 px-2 bg-background"
          projectId={projectId}
        />
      ))}
    </div>
  );
}
