"use server";

import { requestInfo } from "rwsdk/worker";
import { getUserIdFromCookie } from "@/app/pages/claudeAuth/routes";
import { setupContainerCredentials } from "@/app/pages/chat/actions";

import { getSandbox } from "@cloudflare/sandbox";
import { env, waitUntil } from "cloudflare:workers";
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

    .executeTakeFirstOrThrow();

  return result;
}

export async function writeTaskToSandbox(
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

  // Use task lane as session id to keep continuity
  const task = await getTaskByContainerId(containerId);

  const sandbox = await getSandbox(env.Sandbox, containerId);
  await sandbox.writeFile(
    "/machinen/PROMPT.md",
    "Refine @/machinen/OVERVIEW.md and @/machinen/SUBTASKS.md.  Use @/machinen/TRANSCRIPT.md and the relevant files in the codebase (@/workspace/*) as context.  Ensure issue and sub-issue descriptions match the current implementation and dependencies.  Keep wording concise, accurate, and consistent across both files.  Highlight relationships between tasks so the workflow is clear.  Fix discrepancies and improve readability for the dev team."
  );

  const process = await sandbox.startProcess(
    `\
bash -c "\
  cd /workspace && \
  cat /machinen/PROMPT.md | \
  IS_SANDBOX=1 claude --dangerously-skip-permissions --model haiku --output-format stream-json --verbose --print\
"`
  );

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

  // read and write the files to storage.
  const newOverview = await sandbox.readFile("/machinen/OVERVIEW.md");
  const newSubtasks = await sandbox.readFile("/machinen/SUBTASKS.md");

  console.log("--------------------------------");
  console.log("newOverview", newOverview.content);
  console.log("newSubtasks", newSubtasks.content);
  console.log("--------------------------------");

  const bucketPrefix = `${containerId}/${task.laneId}`;

  await env.CONTEXT_STREAM.put(
    `${bucketPrefix}/OVERVIEW.md`,
    newOverview.content
  );
  await env.CONTEXT_STREAM.put(
    `${bucketPrefix}/SUBTASKS.md`,
    newSubtasks.content
  );

  return {
    overview: newOverview.content,
    subtasks: newSubtasks.content,
  };
}
