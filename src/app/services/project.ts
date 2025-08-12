import { db } from "@/db";

export async function getProjectInfo(containerId: string) {
  let { repository, runOnBoot, processCommand, exposePorts } = await db
    .selectFrom("tasks")
    .where("containerId", "=", containerId)
    .innerJoin("projects", "tasks.projectId", "projects.id")
    .select("projects.repository")
    .select("projects.runOnBoot")
    .select("projects.processCommand")
    .select("projects.exposePorts")
    .executeTakeFirstOrThrow();

  const runOnBootClean = Array.isArray(runOnBoot)
    ? (runOnBoot
        .filter((cmd) => cmd.trim().length > 0)
        .map((cmd) => cmd.trim()) as string[])
    : [];

  return {
    repository,
    runOnBoot: runOnBootClean,
    processCommand,
    exposePorts,
  };
}
