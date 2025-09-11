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
      "lanes.systemPrompt",
    ])
    .executeTakeFirst();

  return result;
}

export async function saveIssue(containerId: string, content: string) {
  // save this to the filesystem.
  const sandbox = await getSandbox(env.Sandbox, containerId);
  await sandbox.writeFile("/workspace/.claude/ISSUE.md", content);
}

export async function enhanceIssue(containerId: string, content: string) {
  // we will grab the content
  // we will grab the transcript
  // we will grab the system prompt
  // we will grab the sub-issues

  // and we'll run a claude chat that allows us to "update" the issue.
  // and "update" sub-issues

  const todo = `\
1. Add a new route called 'ping' that returns 'pong' as a response.
2. Return a response code of 200.
`;
  const transcript = `\
Peter: I want to add a new route called 'ping' that returns 'pong' as a response.
Herman: I don't know why you want to do that?
Peter: Because I want to demo this thing to people, don't you understand what we're trying to build man?
Herman: I do kinda get it, but is this a good demo?
Peter: Trust me.
`;

  const sandbox = await getSandbox(env.Sandbox, containerId);
  await sandbox.writeFile("/workspace/.claude/ISSUE/CONTENT.md", content);
  await sandbox.writeFile("/workspace/.claude/ISSUE/TRANSCRIPT.md", transcript);
  await sandbox.writeFile("/workspace/.claude/ISSUE/TODO.md", todo);
}~
