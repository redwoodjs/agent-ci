// Headless Claude Code runner.
// Injects the variant as CLAUDE.md in the scratch repo so the agent picks it
// up via project-instructions auto-discovery — same path a real user would use.
// Captures stream-json so we can replay tool calls and file edits into the scorer.

import { execa } from "execa";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function run({
  workdir,
  taskPath,
  variantPath,
  model = "claude-sonnet-4-6",
  maxBudgetUsd = 1,
}) {
  const variant = await readFile(variantPath, "utf8");
  // Append the variant to any existing fixture CLAUDE.md (repo rules + skill text,
  // matching how real users configure it). If no CLAUDE.md exists, this just writes one.
  const claudePath = join(workdir, "CLAUDE.md");
  const existing = await readFile(claudePath, "utf8").catch(() => "");
  const merged = existing ? `${existing.trimEnd()}\n\n${variant}` : variant;
  await writeFile(claudePath, merged);

  const task = await readFile(taskPath, "utf8");

  const proc = await execa(
    "claude",
    [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      model,
      "--max-budget-usd",
      String(maxBudgetUsd),
      "--no-session-persistence",
      task,
    ],
    { cwd: workdir, reject: false, all: true, timeout: 5 * 60_000 },
  );

  const events = [];
  for (const line of (proc.stdout ?? "").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip non-json */
    }
  }

  return { events, exitCode: proc.exitCode, stderr: proc.stderr };
}

export function extractStreams(events) {
  const toolCalls = [];
  const fileEdits = [];
  const text = [];

  for (const ev of events) {
    const msg = ev?.message;
    if (!msg || !Array.isArray(msg.content)) {
      continue;
    }
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        const { name, input } = block;
        toolCalls.push({ name, input, flat: flatten(input) });
        if (name === "Edit" || name === "Write") {
          fileEdits.push({
            path: input.file_path,
            // Write: whole new contents. Edit: new_string only.
            content: input.new_string ?? input.content ?? "",
          });
        }
      } else if (block.type === "text") {
        text.push(block.text);
      }
    }
  }

  return { toolCalls, fileEdits, text };
}

function flatten(obj) {
  if (obj == null) {
    return "";
  }
  if (typeof obj === "string") {
    return obj;
  }
  return Object.values(obj).map(flatten).join(" ");
}
