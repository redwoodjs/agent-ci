"use server";
import { db } from "@/db";

function sanitizeRunOnBoot(runOnBoot: string) {
  return JSON.stringify(
    runOnBoot
      .split("\n")
      .map((cmd) => cmd.trim())
      .filter((cmd) => cmd.trim().length > 0)
  );
}

export async function createProjectAction(prevState: any, formData: FormData) {
  const name = String(formData.get("name") || "");
  const description = String(formData.get("description") || "");
  const runOnBootRaw = String(formData.get("runOnBoot") || "");
  const runOnBoot = sanitizeRunOnBoot(runOnBootRaw);
  const processCommand = String(formData.get("processCommand") || "");
  const repository = String(formData.get("repository") || "");
  const exposePorts = String(formData.get("exposePorts") || "");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const result = await db
    .insertInto("projects")
    .values({
      id,
      name,
      description,
      runOnBoot,
      processCommand,
      repository,
      exposePorts,
      createdAt: now,
      updatedAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return {
    id: result.id,
    name: result.name,
    description: result.description,
    runOnBoot: result.runOnBoot,
    processCommand: result.processCommand,
    repository: result.repository,
    exposePorts: result.exposePorts,
  };
}

export async function editProjectAction(prevState: any, formData: FormData) {
  const id = String(formData.get("id") || "");
  const name = String(formData.get("name") || "");
  const description = String(formData.get("description") || "");
  const runOnBootRaw = String(formData.get("runOnBoot") || "");
  const runOnBoot = sanitizeRunOnBoot(runOnBootRaw);
  const processCommand = String(formData.get("processCommand") || "");
  const repository = String(formData.get("repository") || "");
  const exposePorts = String(formData.get("exposePorts") || "");

  if (!id || !name || !description) {
    return { error: "Missing required fields" };
  }

  const now = new Date().toISOString();

  const result = await db
    .updateTable("projects")
    .set({
      name,
      description,
      runOnBoot,
      processCommand,
      repository,
      exposePorts,
      updatedAt: now,
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return {
    success: true,
    project: {
      id: result.id,
      name: result.name,
      description: result.description,
      runOnBoot: result.runOnBoot,
      processCommand: result.processCommand,
      repository: result.repository,
      exposePorts: result.exposePorts,
    },
  };
}

export async function createTaskAction(prevState: any, formData: FormData) {
  const projectId = String(formData.get("projectId") || "");
  const name = String(formData.get("name") || "");
  const containerId = String(formData.get("containerId") || "");

  if (!projectId || !name || !containerId) {
    return { error: "Missing required fields" };
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  // Find the default lane for this project, or the first available lane
  const defaultLane = await db
    .selectFrom("lanes")
    .where("projectId", "=", projectId)
    .where("isDefault", "=", true)
    .selectAll()
    .executeTakeFirst();

  const fallbackLane = !defaultLane
    ? await db
        .selectFrom("lanes")
        .where("projectId", "=", projectId)
        .selectAll()
        .orderBy("position", "asc")
        .executeTakeFirst()
    : null;

  const targetLane = defaultLane || fallbackLane;

  // Get the next position in the target lane
  const maxPosition = targetLane
    ? await db
        .selectFrom("tasks")
        .where("laneId", "=", targetLane.id)
        .select(db.fn.max("position").as("maxPosition"))
        .executeTakeFirst()
    : null;

  const position = (maxPosition?.maxPosition || 0) + 1;

  const result = await db
    .insertInto("tasks")
    .values({
      id,
      projectId,
      containerId,
      name,
      status: "pending",
      laneId: targetLane?.id || null,
      position,
      createdAt: now,
      updatedAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return {
    success: true,
    task: {
      id: result.id,
      name: result.name,
      containerId: result.containerId,
      status: result.status,
    },
  };
}
