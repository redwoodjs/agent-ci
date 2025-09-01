"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { db } from "@/db";

export async function getTaskByContainerId(containerId: string) {
  const result = await db
    .selectFrom("tasks")
    .leftJoin("lanes", "tasks.laneId", "lanes.id")
    .where("tasks.containerId", "=", containerId)
    .select([
      "tasks.id",
      "tasks.name",
      "tasks.projectId", 
      "tasks.containerId",
      "tasks.status",
      "tasks.laneId",
      "lanes.name as laneName",
      "lanes.systemPrompt"
    ])
    .executeTakeFirst();

  return result;
}

export async function saveIssue(containerId: string, content: string) {
  // save this to the filesystem.
  const sandbox = await getSandbox(env.Sandbox, containerId);
  await sandbox.writeFile("/workspace/.claude/ISSUE.md", content);
}
