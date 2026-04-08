import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./output/working-directory.js";

/**
 * Get the fetch URL of the first git remote, preferring 'origin'.
 * Uses a single `git remote -v` call to avoid multiple process spawns.
 */
export function getFirstRemoteUrl(cwd: string): string | null {
  try {
    const output = execSync("git remote -v", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!output) {
      return null;
    }

    // Each line: "<name>\t<url> (fetch|push)"
    const lines = output.split("\n");
    let firstFetchUrl: string | null = null;
    for (const line of lines) {
      if (!line.endsWith("(fetch)")) {
        continue;
      }
      const url = line.split("\t")[1]?.replace(/ \(fetch\)$/, "");
      if (!url) {
        continue;
      }
      if (line.startsWith("origin\t")) {
        return url;
      }
      firstFetchUrl ??= url;
    }
    return firstFetchUrl;
  } catch {
    return null;
  }
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
 * Falls back to `fallback` (default "unknown/unknown") when detection fails.
 */
export function resolveRepoSlug(cwd: string, fallback = "unknown/unknown"): string {
  const remoteUrl = getFirstRemoteUrl(cwd);
  if (remoteUrl) {
    return parseRepoSlug(remoteUrl) ?? fallback;
  }
  return fallback;
}

export const config = {
  GITHUB_REPO: process.env.GITHUB_REPO || "unknown/unknown",
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
