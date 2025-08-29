import { db } from "@/db";

import { Board } from "./components/Board";
import { Heading } from "@/app/components/ui/Heading";
import { link } from "@/app/shared/links";

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
        <a
          href={link("/projects/:projectId/edit", {
            projectId: params.projectId,
          })}
        >
          Edit
        </a>
      </div>
      <Board projectId={params.projectId} />
    </div>
  );
}
