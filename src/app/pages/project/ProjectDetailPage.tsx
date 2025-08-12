import { db } from "@/db";
import { TaskList } from "./components/TaskList";
import { ProjectEdit } from "./components/ProjectEdit";

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
      <ProjectEdit project={project} />
      <TaskList projectId={params.projectId} />
    </div>
  );
}
