import { db } from "@/db";

import { ProjectEdit } from "./components/ProjectEdit";

export async function ProjectEditPage({
  params,
}: {
  params: { projectId: string };
}) {
  const project = await db
    .selectFrom("projects")
    .where("id", "=", params.projectId)
    .selectAll()
    .executeTakeFirstOrThrow();

  return <ProjectEdit project={project} />;
}
