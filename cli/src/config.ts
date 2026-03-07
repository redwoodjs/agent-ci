import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { PROJECT_ROOT } from "./working-directory.js";

/**
 * Derive `owner/repo` from the git remote URL.
 * Falls back to "unknown/unknown" if detection fails.
 */
function deriveGithubRepo(): string {
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
    }).trim();
    // Handles both SSH (git@github.com:owner/repo.git) and HTTPS URLs
    const match = remoteUrl.match(/[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) {
      return match[1];
    }
  } catch {
    // git not available or no remote configured
  }
  return "unknown/unknown";
}

export const config = {
  GITHUB_REPO: process.env.GITHUB_REPO || deriveGithubRepo(),
  GITHUB_API_URL: process.env.GITHUB_API_URL || "http://localhost:8910",
};

/**
 * Load machine-local secrets from `.env.machine` at the machinen project root.
 * The file uses KEY=VALUE syntax (lines starting with # are ignored).
 * Returns an empty object if the file doesn't exist.
 */
export function loadMachineSecrets(baseDir?: string): Record<string, string> {
  const envMachinePath = path.join(baseDir ?? PROJECT_ROOT, ".env.machinen");
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
