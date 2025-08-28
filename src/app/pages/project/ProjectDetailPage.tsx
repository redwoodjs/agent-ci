import { db } from "@/db";

import { ProjectEdit } from "./components/ProjectEdit";

import { Board } from "./components/Board";

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
      <Board projectId={params.projectId} />
    </div>
  );
}
