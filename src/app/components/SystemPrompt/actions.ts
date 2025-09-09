"use server";

import { requestInfo } from "rwsdk/worker";
import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

import { getTaskByContainerId } from "@/app/pages/task/actions";
import { db } from "@/db";
import { getUserIdFromCookie } from "@/app/pages/claudeAuth/routes";
import { sendAuthenticatedMessage } from "@/app/pages/chat/action";

export async function resetClaudeSession(containerId: string) {
  // TODO: Implement

  const task = await getTaskByContainerId(containerId);
  if (!task?.laneId) {
    throw new Error("Task does not have a lane");
  }
  // get the system prompt
  const lane = await db
    .selectFrom("lanes")
    .where("id", "=", task.laneId)
    .select("systemPrompt")
    .executeTakeFirstOrThrow();

  console.log("System prompt:", lane.systemPrompt);

  // how to get userId?
  const userId = getUserIdFromCookie(requestInfo.request);
  if (!userId) {
    throw new Error("No user ID found");
  }

  const sandbox = await getSandbox(env.Sandbox, containerId);
  await sandbox.exec(`cd /workspace`);
  await sandbox.startProcess(
    `claude --model sonnet --output-format stream-json --append-system-prompt "${lane.systemPrompt}" --print "/clear"`
  );
}
