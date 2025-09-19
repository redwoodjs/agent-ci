import { db } from "@/db";

import { link } from "@/app/shared/links";

export async function ProjectListPage() {
  const projects = await db.selectFrom("projects").selectAll().execute();

  return (
    <div className="m-4">
      <div className="p-4 border mb-6">
        <div className="flex justify-between items-start mb-4">
          <h1 className="font-advercase font-bold text-3xl">Projects</h1>
        </div>
        <ul className="flex flex-row gap-2">
          {projects.map((result) => (
            <li key={result.id} className="border flex-1">
              <a href={link("/projects/:projectId", { projectId: result.id })}>
                <h2>{result.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {result.description}
                </p>
                <p className="text-sm text-muted-foreground">
                  {result.repository}
                </p>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
