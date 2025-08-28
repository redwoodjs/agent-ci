import { db } from "@/db";

import { Board } from "./components/Board";
import { Heading } from "@/app/components/ui/Heading";

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
      <div className="flex justify-between items-center mb-4">
        <Heading>{project.name}</Heading>
        <a href={`/projects/${project.id}/edit`}>Edit</a>
      </div>
      <Board projectId={params.projectId} />
    </div>
  );
}
