"use server";

import { requestInfo } from "rwsdk/worker";
import { getUserIdFromCookie } from "@/app/pages/claudeAuth/routes";
import { setupContainerCredentials } from "@/app/pages/chat/actions";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { db } from "@/db";
import { sendClaudeMessage } from "@/lib/claude";

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

export async function saveTask(
  containerId: string,
  overview: string,
  subtasks: string
) {
  const task = await getTaskByContainerId(containerId);
  await writeTaskToBucket(containerId, task.id, overview, subtasks);
  await writeTaskToSandbox(containerId, overview, subtasks);
}

async function writeTaskToBucket(
  containerId: string,
  taskId: string,
  overview: string,
  subtasks: string
) {
  const bucketPrefix = `${containerId}/${taskId}`;
  const r = await env.CONTEXT_STREAM.put(
    `${bucketPrefix}/OVERVIEW.md`,
    overview
  );
  console.log("wrote task to bucket", r);
  const r2 = await env.CONTEXT_STREAM.put(
    `${bucketPrefix}/SUBTASKS.md`,
    subtasks
  );
  console.log("wrote task to bucket", r2);
}

async function writeTaskToSandbox(
  containerId: string,
  overview: string,
  subtasks: string
) {
  // save this to the filesystem.
  const transcript = `\
  Peter: I want to add a new route called 'ping' that returns 'pong' as a response.
  Herman: I don't know why you want to do that?
  Peter: Because I want to demo this thing to people, don't you understand what we're trying to build man?
  Herman: I do kinda get it, but is this a good demo?
  Peter: Trust me.
  `;

  const sandbox = await getSandbox(env.Sandbox, containerId);
  await sandbox.writeFile("/machinen/OVERVIEW.md", overview);
  await sandbox.writeFile("/machinen/SUBTASKS.md", subtasks);
  await sandbox.writeFile("/machinen/TRANSCRIPT.md", transcript);
}

export async function enhanceTask(
  containerId: string,
  overview: string,
  subtasks: string
) {
  await writeTaskToSandbox(containerId, overview, subtasks);

  // and we'll run a claude chat that allows us to "update" the issue.
  // and "update" sub-issues

  // Setup Claude credentials for this container (OAuth)
  const userId = getUserIdFromCookie(requestInfo.request);
  if (!userId) {
    throw new Error("No user session found for Claude");
  }
  await setupContainerCredentials(containerId, userId);
  const sandbox = await getSandbox(env.Sandbox, containerId);

  const transcript = `\
  Peter (Product Manager): I want to add a new route called 'ping' that returns 'pong' as a response.
  Herman (Developer): I don't know why you want to do that?
  Peter (Product Manager): Because I want to demo this thing to people, don't you understand what we're trying to build man?
  Herman (Developer): I do kinda get it, but is this a good demo?
  Peter (Product Manager): I think it is. It shows off the simplicity of RedwoodSDK.
  Herman (Developer): Ok, can we make it a bit more interesting?
  Peter (Product Manager): In what way?
  Herman (Developer): Why don't we ask a param as input and we reverse it? Kinda like an echo.
  Peter (Product Manager): Yes, that's a good idea, since it'll also show off how to get the params from the request's URL.
  Herman (Developer): Ok, let's do that!
  `;

  const prompt = `\
You are a product manager for a software development team.
You are given a task's overview, subtasks and a transcript of a conversation between team members.
You are to refine the task and the subtasks.

# Overview:
${overview}

# Subtasks:
${subtasks}

# Transcript:
${transcript}

# Codebase:
@/workspace/*

First, assist in developing a PRD using a structured format that includes:
Problem Statement, Goals, Objectives and Summary (TL;DR).
Write the PRD in markdown format over here: @/machinen/OVERVIEW.md

Then, assist in creating an actionable plan, base this off the new PRD in @/machinen/OVERVIEW.md, the subtasks, and then transcript.
Write the subtasks in markdown format over here: @/machinen/SUBTASKS.md

Be concise and to the point. Do not add things that are not actionable such as "the code should be clean and concise."
`;

  const process = await sendClaudeMessage(containerId, prompt, "haiku");

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
}
