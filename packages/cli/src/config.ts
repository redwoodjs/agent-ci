import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./output/working-directory.js";

/**
 * Get the URL of the first git remote, preferring 'origin'.
 * Uses `git remote get-url` which is scoped to the repo (unlike `git config`
 * which can leak values from global/system config on CI runners).
 */
export function getFirstRemoteUrl(cwd: string): string | null {
  const exec = (cmd: string) =>
    execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    return exec("git remote get-url origin") || null;
  } catch {
    // origin doesn't exist — fall back to the first listed remote
    try {
      const firstName = exec("git remote").split("\n")[0];
      if (firstName) {
        return exec(`git remote get-url ${firstName}`) || null;
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

function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) {
    return result;
  }
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Load machine-local secrets from `.env.agent-ci` at the given base directory.
 * The file uses KEY=VALUE syntax (lines starting with # are ignored).
 *
 * When `envFallbackKeys` is provided, any key in that list that is NOT already
 * present in the file will be filled from `process.env` (shell environment
 * variables act as a fallback for the .env file).
 *
 * Returns an empty object if the file doesn't exist and no env fallbacks match.
 */
export function loadMachineSecrets(
  baseDir?: string,
  envFallbackKeys?: string[],
): Record<string, string> {
  const envMachinePath = path.join(baseDir ?? PROJECT_ROOT, ".env.agent-ci");
  const secrets = parseEnvFile(envMachinePath);
  // Fill missing secrets from process.env (shell env vars act as fallback)
  if (envFallbackKeys) {
    for (const key of envFallbackKeys) {
      if (!secrets[key] && process.env[key]) {
        secrets[key] = process.env[key]!;
      }
    }
  }
  return secrets;
}

/**
 * Apply `AGENT_CI_*` entries from `.env.agent-ci` to `process.env`.
 *
 * Shell env wins: a key already present in `process.env` is left untouched.
 * Only `AGENT_CI_*`-prefixed keys are copied — workflow secret values that
 * coexist in this file stay in the file and are read via `loadMachineSecrets`.
 */
export function applyAgentCiEnv(baseDir?: string): void {
  const envMachinePath = path.join(baseDir ?? PROJECT_ROOT, ".env.agent-ci");
  const parsed = parseEnvFile(envMachinePath);
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith("AGENT_CI_")) {
      continue;
    }
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}
