"use server";
import { db } from "@/db";

export async function getLanesForProject(projectId: string) {
  return await db
    .selectFrom("lanes")
    .where("projectId", "=", projectId)
    .selectAll()
    .orderBy("position", "asc")
    .execute();
}

export async function getTasksByLane(projectId: string) {
  const tasks = await db
    .selectFrom("tasks")
    .leftJoin("lanes", "tasks.laneId", "lanes.id")
    .where("tasks.projectId", "=", projectId)
    .select([
      "tasks.id",
      "tasks.name",
      "tasks.containerId",
      "tasks.status",
      "tasks.createdAt",
      "tasks.updatedAt",
      "tasks.laneId",
      "tasks.position",
      "lanes.name as laneName",
    ])
    .orderBy("tasks.position", "asc")
    .orderBy("tasks.createdAt", "desc")
    .execute();

  return tasks;
}

export async function createDefaultLanesForProject(projectId: string) {
  const now = new Date().toISOString();

  const defaultLanes = [
    { name: "To Do", position: 0, isDefault: true },
    { name: "In Progress", position: 1, isDefault: false },
    { name: "Done", position: 2, isDefault: false },
  ];

  const createdLanes = [];
  for (const lane of defaultLanes) {
    const result = await db
      .insertInto("lanes")
      .values({
        id: crypto.randomUUID(),
        projectId,
        name: lane.name,
        position: lane.position,
        isDefault: lane.isDefault,
        createdAt: now,
        updatedAt: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    createdLanes.push(result);
  }

  return createdLanes;
}

export async function createLane(
  projectId: string,
  name: string,
  position?: number,
  systemPrompt?: string
) {
  const now = new Date().toISOString();

  // If no position specified, put it at the end
  if (position === undefined) {
    const maxPosition = await db
      .selectFrom("lanes")
      .where("projectId", "=", projectId)
      .select(db.fn.max("position").as("maxPosition"))
      .executeTakeFirst();

    position = (maxPosition?.maxPosition || 0) + 1;
  }

  return await db
    .insertInto("lanes")
    .values({
      id: crypto.randomUUID(),
      projectId,
      name,
      position,
      isDefault: false,
      systemPrompt,
      createdAt: now,
      updatedAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateLane(
  laneId: string,
  name: string,
  systemPrompt?: string
) {
  const now = new Date().toISOString();

  return await db
    .updateTable("lanes")
    .set({
      name,
      systemPrompt,
      updatedAt: now,
    })
    .where("id", "=", laneId)
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function deleteLane(laneId: string) {
  // First, move any tasks in this lane to the default lane of the same project
  const lane = await db
    .selectFrom("lanes")
    .where("id", "=", laneId)
    .select(["projectId"])
    .executeTakeFirstOrThrow();

  const defaultLane = await db
    .selectFrom("lanes")
    .where("projectId", "=", lane.projectId)
    .where("isDefault", "=", true)
    .selectAll()
    .executeTakeFirst();

  if (defaultLane) {
    await db
      .updateTable("tasks")
      .set({ laneId: defaultLane.id })
      .where("laneId", "=", laneId)
      .execute();
  } else {
    // If no default lane exists, set tasks to null
    await db
      .updateTable("tasks")
      .set({ laneId: null })
      .where("laneId", "=", laneId)
      .execute();
  }

  return await db.deleteFrom("lanes").where("id", "=", laneId).execute();
}
