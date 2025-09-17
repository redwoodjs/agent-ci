import { getSandbox, Sandbox } from "@cloudflare/sandbox";
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
  const { laneId } = await db
    .selectFrom("tasks")
    .where("containerId", "=", containerId)
    .select("laneId")
    .executeTakeFirstOrThrow();

  const userId = getUserIdFromCookie(requestInfo.request);
  if (!userId) {
    throw new Error("No user session found for Claude");
  }
  await setupContainerCredentials(containerId, userId);

  const sandbox = getSandbox(env.Sandbox, containerId);
  if (!hasSystemPrompt({ sandbox, laneId })) {
    await updateSystemPrompt({ sandbox, laneId, clear: false });
  }

  await sandbox.writeFile(`/machinen/INPUT.md`, message);
  return await sandbox.startProcess(`\
bash -c "\
  cd /workspace && \
  cat /machinen/INPUT.md | \
  IS_SANDBOX=1 claude \
    --append-system-prompt \"$(cat /machinen/${laneId}-system-prompt.md)\" \
    --dangerously-skip-permissions \
    --model ${model} \
    --output-format stream-json \
    --verbose \
    --print"`);
}

async function hasSystemPrompt({
  sandbox,
  laneId,
}: {
  sandbox: DurableObjectStub<Sandbox>;
  laneId: string;
}) {
  const systemPromptFile = await sandbox.readFile(
    `/machinen/${laneId}-system-prompt.md`
  );
  return systemPromptFile.success;
}

export async function updateSystemPrompt({
  sandbox,
  laneId,
  clear,
}: {
  sandbox: DurableObjectStub<Sandbox>;
  laneId: string;
  clear: boolean;
}) {
  const { systemPrompt } = await db
    .selectFrom("lanes")
    .where("id", "=", laneId)
    .select("systemPrompt")
    .executeTakeFirstOrThrow();

  await sandbox.writeFile(`/machinen/${laneId}-system-prompt.md`, systemPrompt);
  if (clear) {
    await sandbox.exec(
      `claude --model sonnet --output-format stream-json --print "/clear"`
    );
  }
}

export async function updateUserPrompt(
  containerId: string,
  contents: {
    title: string;
    overview: string;
    subtasks: string;
    transcript: string;
  }
) {
  const prompt = `\
  # Title:
  ${contents.title}
  
  # Overview:
  ${contents.overview}
  
  # Subtasks:
  ${contents.subtasks}
  
  # Transcript:
  ${contents.transcript}
  
  # Codebase: @/workspace/*
`;

  const sandbox = getSandbox(env.Sandbox, containerId);
  await sandbox.writeFile(`/root/.claude/CLAUDE.md`, prompt);
}
