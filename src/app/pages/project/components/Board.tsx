import {
  createDefaultLanesForProject,
  getLanesForProject,
  getTasksByLane,
} from "@/app/services/lanes";

import ColumnWrapper from "./ColumnWrapper";

// Types
export interface TaskItem {
  id: string;
  name: string;
}

export interface Lane {
  id: string,
    projectId: string,
    name: string,
    position: number,
    isDefault: boolean,
    createdAt: string,
    updatedAt: string,
    systemPrompt: string | null
  tasks: TaskItem[];
}

export async function Board({ projectId }: { projectId: string }) {
  const lanes = await getLanesForProject(projectId);
  if (lanes.length === 0) {
    await createDefaultLanesForProject(projectId);
  }
  const tasks = await getTasksByLane(projectId);
  // console.log("tasks", tasks);
  const pragmaticLanes = lanes.map((lane) => ({
    ...lane,
    tasks: tasks.filter((task) => task.laneId === lane.id),
  }));

  return (
    <ColumnWrapper lanes={pragmaticLanes as unknown as Lane[]} projectId={projectId} />
  );
}
