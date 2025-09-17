"use server";

import { requestInfo } from "rwsdk/worker";
import { getUserIdFromCookie } from "@/app/pages/claudeAuth/routes";
import { setupContainerCredentials } from "@/app/pages/chat/actions";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { db } from "@/db";
import { sendClaudeMessage } from "@/lib/claude";
import { getContextFile, setContextFile } from "@/lib/storage";

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

  await Promise.all([
    setContextFile(containerId, "overview.md", overview),
    setContextFile(containerId, "subtasks.md", subtasks),
  ]);
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

  // Setup Claude credentials for this container (OAuth)
  const userId = getUserIdFromCookie(requestInfo.request);
  if (!userId) {
    throw new Error("No user session found for Claude");
  }
  await setupContainerCredentials(containerId, userId);

  const prompt = `\
You are a product manager for a software development team.
You are given a task's overview, subtasks and a transcript of a conversation between team members.
You are to refine the task and the subtasks.

# Title:
${title}

# Overview:
${overview}

# Subtasks:
${subtasks}

# Transcript:
${transcript}

# Codebase: /workspace/*

First, assist in developing a PRD using a structured format that includes:
Problem Statement, Goals, Objectives and Summary (TL;DR).
Write the PRD in markdown format over here:
/machinen/task/enhanced_overview.md

Then, create an actionable plan from the new PRD, the original subtasks, the transcripts, and the code.
Write the subtasks in markdown format over here:
/machinen/task/enhanced_subtasks.md

Be concise and to the point. Do not add things that are not actionable such as "the code should be clean and concise."
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
