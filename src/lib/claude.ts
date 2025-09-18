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
  const userId = getUserIdFromCookie(requestInfo.request);
  if (!userId) {
    throw new Error("No user session found for Claude");
  }
  await setupContainerCredentials(containerId, userId);

  const sandbox = getSandbox(env.Sandbox, containerId);
  const messageFile = `/tmp/message_${Date.now()}.txt`;
  await sandbox.writeFile(messageFile, message);

  return await sandbox.startProcess(`\
bash -c "\
  cd /workspace && \
  cat ${messageFile} | \
  IS_SANDBOX=1 claude \
    --dangerously-skip-permissions \
    --model ${model} \
    --output-format stream-json \
    --verbose \
    --print \
    "`);
}

export async function updateUserPrompt(
  containerId: string,
  contents: {
    title: string;
    overview: string;
    subtasks: string;
    transcript: string;
    systemPrompt: string;
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

  # System Prompt:
  ${contents.systemPrompt}
`;

  const sandbox = getSandbox(env.Sandbox, containerId);
  await sandbox.writeFile(`/root/.claude/CLAUDE.md`, prompt);
}
