import { db } from "@/db";
import { TaskList } from "./TaskList";

export async function ProjectDetailPage({
  params,
}: {
  params: { projectId: string };
}) {
  const project = await db
    .selectFrom("projects")
    .where("id", "=", params.projectId)
    .selectAll()
    .executeTakeFirstOrThrow();

  return (
    <div className="p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-4">Project: {project.name}</h1>
        <div className="space-y-2">
          <p><strong>Description:</strong> {project.description}</p>
          <p><strong>Run on Boot:</strong> {project.runOnBoot}</p>
          {project.repository && <p><strong>Repository:</strong> {project.repository}</p>}
        </div>
      </div>
      
      <TaskList projectId={params.projectId} />
    </div>
  );
}
