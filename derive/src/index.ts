import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
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

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const WATCH_DEBOUNCE_MS = 5_000;

// --GROK--: Shells out to git to get the current branch name.
// Rejects detached HEAD since we need a named branch for spec routing.
function getCurrentBranch(): string {
  const branch = execSync("git rev-parse --abbrev-ref HEAD", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  if (branch === "HEAD") {
    console.error("[derive] detached HEAD — a named branch is required");
    process.exit(1);
  }

  return branch;
}

// --GROK--: Computes the slug directory where Claude Code stores conversations
// for a given cwd. Mirrors Claude Code's own slugification: replace / with -.
function getSlugDir(cwd: string): string {
  // --GROK--: Claude Code replaces both / and _ with - when slugifying.
  // Previously we only replaced /, causing lookups to miss directories
  // for cwds containing underscores (e.g. opposite-actions_specs).
  const slug = cwd.replace(/[/_]/g, "-");
  return path.join(CLAUDE_PROJECTS_DIR, slug);
}

// --GROK--: DB-first reconciliation. Queries the DB for known conversations on
// this branch, then diffs against the filesystem to find truly new JSONL files.
// New files are read to extract their gitBranch — matching ones are indexed.
// Non-matching files are also indexed (for their actual branch) so the
// primary-key lookup skips them on future invocations.
async function discoverConversations(cwd: string, branch: string): Promise<void> {
  const slugDir = getSlugDir(cwd);
  console.log(`[discover] slug dir: ${slugDir}`);

  if (!fs.existsSync(slugDir)) {
    console.log(`[discover] slug dir does not exist — no conversations to discover`);
    return;
  }

  const known = getConversationsForBranch(cwd, branch);
  const knownIds = new Set(known.map((c) => c.conversationId));
  console.log(`[discover] ${known.length} conversation(s) already known in DB for ${branch}`);

  const files = fs.readdirSync(slugDir).filter((f) => f.endsWith(".jsonl"));
  console.log(`[discover] ${files.length} jsonl file(s) found in slug dir`);
  let discoveredCount = 0;

  for (const file of files) {
    const conversationId = path.basename(file, ".jsonl");

    if (knownIds.has(conversationId)) {
      continue;
    }

    // Already indexed for another branch — skip the file read
    const existing = getConversation(conversationId);
    if (existing) {
      continue;
    }

    // Truly new — read to discover cwd + gitBranch
    const jsonlPath = path.join(slugDir, file);
    const { messages } = await readFromOffset(jsonlPath, 0);
    const first = messages.find((m) => m.cwd && m.gitBranch);

    if (!first) {
      continue;
    }

    upsertConversation({
      conversationId,
      repoPath: first.cwd,
      branch: first.gitBranch,
      jsonlPath,
      lastLineOffset: 0,
      updatedAt: new Date().toISOString(),
    });

    if (first.gitBranch === branch) {
      discoveredCount++;
      console.log(`[discover] new conversation: ${conversationId}`);
    } else {
      console.log(`[discover] indexed ${conversationId} (branch: ${first.gitBranch})`);
    }
  }

  if (discoveredCount > 0) {
    console.log(`[discover] found ${discoveredCount} new conversation(s) for ${branch}`);
  }
}

async function runSpecUpdate(repoPath: string, branch: string): Promise<void> {
  console.log(`[spec] updating spec for ${repoPath} @ ${branch}`);

  const conversations = getConversationsForBranch(repoPath, branch);
  if (conversations.length === 0) {
    console.log("[derive] no conversations found for this branch");
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
    console.log("[derive] no new messages");
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

// --GROK--: Reset mode. Discovery has already reconciled the DB, so
// getConversationsForBranch returns the complete set. We zero offsets and
// reprocess each conversation sequentially — one updateSpec call per
// conversation to avoid exceeding the prompt size limit.
async function resetBranch(cwd: string, branch: string): Promise<void> {
  console.log(`[reset] resetting spec for ${cwd} @ ${branch}`);

  const conversations = getConversationsForBranch(cwd, branch);
  if (conversations.length === 0) {
    console.log(`[reset] no conversations found for ${cwd} @ ${branch}`);
    return;
  }

  const sPath = specFilePath(cwd, branch);

  if (fs.existsSync(sPath)) {
    fs.unlinkSync(sPath);
    console.log(`[reset] deleted existing spec at ${sPath}`);
  }

  const resetCount = resetConversationOffsets(cwd, branch);
  console.log(`[reset] zeroed offsets for ${resetCount} conversations`);

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
    repoPath: cwd,
    branch,
    specPath: sPath,
    updatedAt: new Date().toISOString(),
  });

  console.log(`[reset] spec written to ${sPath}`);
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const branch = getCurrentBranch();
  const args = process.argv.slice(2);

  console.log(`[derive] ${cwd} @ ${branch}`);

  // --GROK--: init mode runs before discovery — no DB work, no tokens.
  // Creates the spec file so the user can fill it in before running derive.
  if (args[0] === "init") {
    const sPath = specFilePath(cwd, branch);
    if (fs.existsSync(sPath)) {
      console.log(`[init] spec already exists: ${sPath}`);
    } else {
      fs.mkdirSync(path.dirname(sPath), { recursive: true });
      fs.writeFileSync(sPath, "", "utf8");
      console.log(`[init] created ${sPath}`);
    }
    return;
  }

  // DB-first discovery: reconcile the DB with the filesystem before any mode
  await discoverConversations(cwd, branch);

  if (args.includes("--reset")) {
    await resetBranch(cwd, branch);
    return;
  }

  if (args[0] === "watch") {
    // Initial update, then watch for changes on this branch
    await runSpecUpdate(cwd, branch);

    const slugDir = getSlugDir(cwd);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    startWatcher(slugDir, () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        discoverConversations(cwd, branch)
          .then(() => runSpecUpdate(cwd, branch))
          .catch((err) => {
            console.error("[watch] spec update failed:", err);
          });
      }, WATCH_DEBOUNCE_MS);
    });

    console.log("[derive] watching for changes...");
    return;
  }

  // Default: one-shot update
  await runSpecUpdate(cwd, branch);
}

const isWatchMode = process.argv.slice(2)[0] === "watch";

main().then(
  () => {
    if (!isWatchMode) {
      process.exit(0);
    }
  },
  (err) => {
    console.error("[derive] failed:", err);
    process.exit(1);
  },
);
