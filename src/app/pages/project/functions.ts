// src/app/pages/project/functions.ts
"use server";
import { db } from "@/db";

export async function createProjectAction(prevState: any, formData: FormData) {
  const name = String(formData.get("name") || "");
  const description = String(formData.get("description") || "");
  const runOnBoot = formData.get("runOnBoot") ? "true" : "false"; // checkbox -> "true"/"false"
  const repository = String(formData.get("repository") || "");

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const result = await db
    .insertInto("projects")
    .values({
      id,
      name,
      description,
      runOnBoot,
      repository,
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
    repository: result.repository,
  };
}

export async function editProjectAction(prevState: any, formData: FormData) {
  const id = String(formData.get("id") || "");
  const name = String(formData.get("name") || "");
  const description = String(formData.get("description") || "");
  const runOnBoot = String(formData.get("runOnBoot") || "");
  const repository = String(formData.get("repository") || "");

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
      repository,
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
      repository: result.repository,
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

  const result = await db
    .insertInto("tasks")
    .values({
      id,
      projectId,
      containerId,
      name,
      status: "pending",
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
