import { db } from "@/db";

export async function ProjectListPage() {
  const projects = await db.selectFrom("projects").selectAll().execute();

  return (
    <div className="m-4">
      <div className="p-4 border">
        <h1 className="font-advercase font-bold text-3xl mb-4">Projects</h1>
        <ul className="flex flex-row gap-2">
          {projects.map((result) => (
            <li key={result.id} className="border flex-1">
              <a href={`/projects/${result.id}`}>
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
          {projects.map((result) => (
            <li key={result.id} className="border flex-1">
              <a href={`/projects/${result.id}`}>
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
