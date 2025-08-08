import { db } from "@/db";

export async function ProjectListPage() {
  const projects = await db.selectFrom("projects").selectAll().execute();

  return (
    <div>
      <h1>Projects</h1>
      <ul>
        {projects.map((result) => (
          <li key={result.id}>
            <a href={`/projects/${result.id}`}>
              {result.name}
              {result.description}
              {result.runOnBoot}
              {result.repository}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
