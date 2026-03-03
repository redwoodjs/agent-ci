import fs from "node:fs";
import path from "node:path";
import { startWatcher } from "./watcher.js";
import { readFromOffset } from "./reader.js";
import {
  upsertConversation,
  getConversation,
  getConversationsForBranch,
  upsertBranch,
  resetConversationOffsets,
} from "./db.js";
import { updateSpec, specFilePath } from "./spec.js";

const SPEC_DEBOUNCE_MS = 5_000;

// Keyed by "repoPath:branch". Pending timers are replaced on each
// new file event so rapid writes coalesce into a single spec update.
const pendingSpecUpdates = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleSpecUpdate(repoPath: string, branch: string): void {
  const key = `${repoPath}:${branch}`;
  const existing = pendingSpecUpdates.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    pendingSpecUpdates.delete(key);
    runSpecUpdate(repoPath, branch).catch((err) => {
      console.error(`[spec] update failed for ${key}:`, err);
    });
  }, SPEC_DEBOUNCE_MS);

  pendingSpecUpdates.set(key, timer);
}

async function runSpecUpdate(repoPath: string, branch: string): Promise<void> {
  console.log(`[spec] updating spec for ${repoPath} @ ${branch}`);

  const conversations = getConversationsForBranch(repoPath, branch);
  if (conversations.length === 0) {
    return;
  }

  const allNewMessages = [];

  for (const conv of conversations) {
    const { messages, linesRead } = await readFromOffset(conv.jsonlPath, conv.lastLineOffset);
    if (messages.length > 0) {
      console.log(
        `[spec] ${conv.jsonlPath}: offset ${conv.lastLineOffset} → ${linesRead} | ${messages.length} new messages`,
      );
    }
    allNewMessages.push(...messages);
    // Advance the offset immediately so a crash mid-update won't
    // re-send the same messages on next run.
    upsertConversation({
      ...conv,
      lastLineOffset: linesRead,
      updatedAt: new Date().toISOString(),
    });
  }

  if (allNewMessages.length === 0) {
    return;
  }

  const sPath = specFilePath(repoPath, branch);

  await updateSpec(allNewMessages, sPath);
  upsertBranch({
    repoPath,
    branch,
    specPath: sPath,
    updatedAt: new Date().toISOString(),
  });

  console.log(`[spec] spec written to ${sPath}`);
}

async function onFileChanged(jsonlPath: string): Promise<void> {
  const conversationId = path.basename(jsonlPath, ".jsonl");
  const existing = getConversation(conversationId);

  if (existing) {
    console.log(`[watch] changed: ${jsonlPath} (${existing.repoPath} @ ${existing.branch})`);
    scheduleSpecUpdate(existing.repoPath, existing.branch);
    return;
  }

  // First time seeing this file — read from start to discover cwd / gitBranch.
  const { messages } = await readFromOffset(jsonlPath, 0);
  const first = messages.find((m) => m.cwd && m.gitBranch);
  if (!first) {
    return;
  }

  console.log(`[watch] discovered: ${jsonlPath} (${first.cwd} @ ${first.gitBranch})`);

  // Store offset as 0; runSpecUpdate will read all lines and advance it.
  upsertConversation({
    conversationId,
    repoPath: first.cwd,
    branch: first.gitBranch,
    jsonlPath,
    lastLineOffset: 0,
    updatedAt: new Date().toISOString(),
  });

  scheduleSpecUpdate(first.cwd, first.gitBranch);
}

// Re-read all conversations from offset 0, delete the existing spec, and
// regenerate from scratch in a single claude -p call. Uses process.cwd() as
// repoPath so it must be run from within the repo.
async function resetBranch(branch: string): Promise<void> {
  const repoPath = process.cwd();
  console.log(`[reset] resetting spec for ${repoPath} @ ${branch}`);

  const conversations = getConversationsForBranch(repoPath, branch);
  if (conversations.length === 0) {
    console.log(`[reset] no conversations found for ${repoPath} @ ${branch}`);
    return;
  }

  const sPath = specFilePath(repoPath, branch);

  // Delete existing spec so updateSpec treats this as a fresh branch
  if (fs.existsSync(sPath)) {
    fs.unlinkSync(sPath);
    console.log(`[reset] deleted existing spec at ${sPath}`);
  }

  // Zero all offsets
  const resetCount = resetConversationOffsets(repoPath, branch);
  console.log(`[reset] zeroed offsets for ${resetCount} conversations`);

  // Process conversations sequentially — each updateSpec call reads the current
  // spec from disk (written by the previous call) and refines it with the next
  // conversation's messages. Same pattern as normal incremental operation.
  let totalMessages = 0;
  for (const [i, conv] of conversations.entries()) {
    const { messages, linesRead } = await readFromOffset(conv.jsonlPath, 0);
    console.log(
      `[reset] (${i + 1}/${conversations.length}) ${conv.jsonlPath}: ${messages.length} messages (${linesRead} lines)`,
    );

    if (messages.length > 0) {
      await updateSpec(messages, sPath);
      totalMessages += messages.length;
      console.log(`[reset] spec updated: ${sPath}`);
    }

    // Advance offset so the daemon won't re-process these
    upsertConversation({
      ...conv,
      lastLineOffset: linesRead,
      updatedAt: new Date().toISOString(),
    });
  }

  if (totalMessages === 0) {
    console.log(`[reset] no user/assistant messages found across conversations`);
    return;
  }

  upsertBranch({
    repoPath,
    branch,
    specPath: sPath,
    updatedAt: new Date().toISOString(),
  });

  console.log(`[reset] spec written to ${sPath}`);
}

const resetFlag = process.argv.indexOf("--reset");
if (resetFlag !== -1) {
  const branch = process.argv[resetFlag + 1];
  if (!branch) {
    console.error("Usage: tsx src/index.ts --reset <branch>");
    process.exit(1);
  }
  resetBranch(branch)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[reset] failed:", err);
      process.exit(1);
    });
} else {
  console.log("[machinen] daemon started");

  startWatcher((jsonlPath) => {
    onFileChanged(jsonlPath).catch((err) => {
      console.error("[machinen] error processing file:", jsonlPath, err);
    });
  });
}
