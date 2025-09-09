import { db } from "@/db";

export async function getProjectInfo(containerId: string) {
  const task = await db
    .selectFrom("tasks")
    .where("containerId", "=", containerId)
    .select("projectId")
    .executeTakeFirstOrThrow();

  let { repository, runOnBoot, processCommand, exposePorts } = await db
    .selectFrom("projects")
    .where("id", "=", task.projectId)
    .select("repository")
    .select("runOnBoot")
    .select("processCommand")
    .select("exposePorts")
    .executeTakeFirstOrThrow();

  const runOnBootClean = Array.isArray(runOnBoot)
    ? (runOnBoot
        .filter((cmd) => cmd.trim().length > 0)
        .map((cmd) => cmd.trim()) as string[])
    : [];

  const exposePortsClean = Array.isArray(exposePorts)
    ? (exposePorts.map((port) => parseInt(port, 10)) as number[])
    : [5173];

  return {
    repository,
    runOnBoot: runOnBootClean,
    processCommand,
    exposePorts: exposePortsClean,
  };
}
