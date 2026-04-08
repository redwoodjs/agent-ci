import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./output/working-directory.js";

/**
 * Get the URL of the first git remote, preferring 'origin'.
 * Uses `git config` for clean output (no parsing of tab-delimited text).
 */
export function getFirstRemoteUrl(cwd: string): string | null {
  const exec = (cmd: string) =>
    execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    // Try origin first (most common)
    return exec("git config --get remote.origin.url") || null;
  } catch {
    // origin doesn't exist — fall back to the first listed remote
    try {
      const firstName = exec("git remote").split("\n")[0];
      if (firstName) {
        return exec(`git config --get remote.${firstName}.url`) || null;
      }
    } catch {}
  }
  return null;
}

/**
 * Extract `owner/repo` from a git remote URL.
 * Handles HTTPS, SSH (git@), and ssh:// URLs, with or without `.git` suffix.
 */
export function parseRepoSlug(remoteUrl: string): string | null {
  const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match ? match[1] : null;
}

/**
 * Detect `owner/repo` from the git remote in the given directory.
 * Throws if detection fails and no fallback is provided.
 */
export function resolveRepoSlug(cwd: string, fallback?: string): string {
  const remoteUrl = getFirstRemoteUrl(cwd);
  if (remoteUrl) {
    const slug = parseRepoSlug(remoteUrl);
    if (slug) {
      return slug;
    }
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(
    `Could not detect GitHub repository from git remotes in ${cwd}. ` +
      `Set the GITHUB_REPO environment variable (e.g. GITHUB_REPO=owner/repo).`,
  );
}

export const config: {
  GITHUB_REPO: string | undefined;
  GITHUB_API_URL: string;
} = {
  GITHUB_REPO: process.env.GITHUB_REPO,
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
