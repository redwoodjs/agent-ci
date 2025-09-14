import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

import { db } from "@/db";
import { setupContainerCredentials } from "@/app/pages/chat/actions";
import { getUserIdFromCookie } from "@/app/pages/claudeAuth/routes";
import { requestInfo } from "rwsdk/worker";

import { ClaudeModel } from "@/types/claude";

async function runAndStreamProcess({
  containerId,
  command,
}: {
  containerId: string;
  command: string;
}) {
  const sandbox = await getSandbox(env.Sandbox, containerId);
  const process = await sandbox.startProcess(command);

  const stream = await sandbox.streamProcessLogs(process.id);
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  return process;
}

export async function sendClaudeMessage(
  containerId: string,
  message: string,
  model: ClaudeModel = "default"
) {
  const task = await db
    .selectFrom("tasks")
    .where("containerId", "=", containerId)
    .select("laneId")
    .innerJoin("lanes", "tasks.laneId", "lanes.id")
    .select("lanes.systemPrompt")
    .executeTakeFirstOrThrow();

  const userId = getUserIdFromCookie(requestInfo.request);
  if (!userId) {
    throw new Error("No user session found for Claude");
  }
  await setupContainerCredentials(containerId, userId);

  const sandbox = await getSandbox(env.Sandbox, containerId);
  let setupFile = await sandbox.readFile(`/machinen/setup-${task.laneId}.json`);
  if (!setupFile.success) {
    const { command, id, startTime, endTime, exitCode } =
      await runAndStreamProcess({
        containerId,
        command: `claude --output-format stream-json --verbose --append-system-prompt "${task.systemPrompt}" --print "/clear"`,
      });

    await sandbox.writeFile(
      `/machinen/setup-${task.laneId}.json`,
      JSON.stringify({
        command,
        id,
        startTime,
        endTime,
        exitCode,
      })
    );
  }

  await sandbox.writeFile(`/machinen/INPUT.md`, message);

  return await sandbox.startProcess(`\
bash -c "\
  cd /workspace && \
  cat /machinen/INPUT.md | \
  IS_SANDBOX=1 claude \
    --dangerously-skip-permissions \
    --model ${model} \
    --output-format stream-json \
    --verbose \
    --print"`);
}
