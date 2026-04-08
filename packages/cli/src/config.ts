import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./output/working-directory.js";

/**
 * Get the URL of the first git remote, preferring 'origin'.
 * Suppresses stderr so git errors don't leak to the terminal.
 */
export function getFirstRemoteUrl(cwd: string): string | null {
  const execOpts = {
    cwd,
    encoding: "utf-8" as const,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
  };
  try {
    return execSync("git remote get-url origin", execOpts).trim();
  } catch {
    // 'origin' doesn't exist — fall back to the first available remote
    try {
      const firstRemote = execSync("git remote", execOpts).trim().split("\n")[0];
      if (firstRemote) {
        return execSync(`git remote get-url ${firstRemote}`, execOpts).trim();
      }
    } catch {}
  }
  return null;
}

function deriveGithubRepo(): string {
  const remoteUrl = getFirstRemoteUrl(process.cwd());
  if (remoteUrl) {
    // Handles both SSH (git@github.com:owner/repo.git) and HTTPS URLs
    const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
    if (match) {
      return match[1];
    }
  }
  return "unknown/unknown";
}

export const config = {
  GITHUB_REPO: process.env.GITHUB_REPO || deriveGithubRepo(),
  GITHUB_API_URL: process.env.GITHUB_API_URL || "http://localhost:8910",
};

/**
 * Load machine-local secrets from `.env.machine` at the agent-ci project root.
 * The file uses KEY=VALUE syntax (lines starting with # are ignored).
 * Returns an empty object if the file doesn't exist.
 */
export function loadMachineSecrets(baseDir?: string): Record<string, string> {
  const envMachinePath = path.join(baseDir ?? PROJECT_ROOT, ".env.agent-ci");
  if (!fs.existsSync(envMachinePath)) {
    return {};
  }
  const secrets: Record<string, string> = {};
  const lines = fs.readFileSync(envMachinePath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip optional surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      secrets[key] = value;
    }
  }
  return secrets;
}
