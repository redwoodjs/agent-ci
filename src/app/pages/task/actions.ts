"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export async function saveIssue(containerId: string, content: string) {
  // save this to the filesystem.
  const sandbox = await getSandbox(env.Sandbox, containerId);
  await sandbox.writeFile("/workspace/.claude/ISSUE.md", content);
}
