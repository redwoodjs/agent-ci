"use server";

import { requestInfo } from "rwsdk/worker";
import { getUserIdFromCookie } from "@/app/pages/claudeAuth/routes";
import { setupContainerCredentials } from "@/app/pages/chat/actions";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { db } from "@/db";
import {
  sendClaudeMessage,
  updateUserPrompt,
  updateSystemPrompt,
} from "@/lib/claude";
import { getContextFile, setContextFile } from "@/lib/storage";

async function getSystemPrompt(containerId: string) {
  const { laneId } = await db
    .selectFrom("tasks")
    .where("containerId", "=", containerId)
    .select("laneId")
    .executeTakeFirstOrThrow();

  const { systemPrompt } = await db
    .selectFrom("lanes")
    .where("id", "=", laneId)
    .select("systemPrompt")
    .executeTakeFirstOrThrow();
  return systemPrompt;
}

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

    .executeTakeFirstOrThrow();

  return result;
}

export async function saveTask({
  containerId,
  title,
  overview,
  subtasks,
}: {
  containerId: string;
  title: string;
  overview: string;
  subtasks: string;
}) {
  await db
    .updateTable("tasks")
    .set({
      name: title,
    })
    .where("containerId", "=", containerId)
    .execute();

  const systemPrompt = await getSystemPrompt(containerId);

  await Promise.all([
    setContextFile(containerId, "overview.md", overview),
    setContextFile(containerId, "subtasks.md", subtasks),
  ]);

  const transcript = await getContextFile(containerId, "transcript.json");
  await updateUserPrompt(containerId, {
    title,
    overview,
    subtasks,
    transcript,
    systemPrompt,
  });
}

export async function enhanceTask({
  containerId,
  title,
  overview,
  subtasks,
}: {
  containerId: string;
  title: string;
  overview: string;
  subtasks: string;
}) {
  await saveTask({ containerId, title, overview, subtasks });

  const transcript = await getContextFile(containerId, "transcript.json");
  const systemPrompt = await getSystemPrompt(containerId);

  await updateUserPrompt(containerId, {
    title,
    overview,
    subtasks,
    transcript,
    systemPrompt,
  });

  const prompt = `\
  Reference the overview, subtasks, trascript, and code in @/workspace/* 
  Create a GitHub Issue, write it in markdown format over here:
  @/machinen/task/enhanced_issue.md
  
  Be concise. 
  Do not add things that are not actionable.
  Only focus on the task at hand.
`;

  const process = await sendClaudeMessage(containerId, prompt, "haiku");
  const sandbox = await getSandbox(env.Sandbox, containerId);
  const x = await sandbox.streamProcessLogs(process.id);
  const reader = x.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // console.log(new TextDecoder().decode(value));
    }
  } finally {
    reader.releaseLock();
  }

  const newOverview = await sandbox.readFile(
    "/machinen/task/enhanced_overview.md"
  );
  const newSubtasks = await sandbox.readFile(
    "/machinen/task/enhanced_subtasks.md"
  );

  // Update the context files/files in the sandbox
  await setContextFile(
    containerId,
    "enhanced_overview.md",
    newOverview.content
  );

  await setContextFile(
    containerId,
    "enhanced_subtasks.md",
    newSubtasks.content
  );
}

export async function updateSystemPromptForTask(containerId: string) {
  const { laneId } = await db
    .selectFrom("tasks")
    .where("containerId", "=", containerId)
    .select("laneId")
    .executeTakeFirstOrThrow();

  const sandbox = await getSandbox(env.Sandbox, containerId);
  await updateSystemPrompt({ sandbox, laneId, clear: false });
}
