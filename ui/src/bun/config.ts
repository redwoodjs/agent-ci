import path from "node:path";
import os from "node:os";
import fsSync from "node:fs";

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "oa", "config.jsonc");

export function parseJsonc(fileContent: string): any {
  let stripped = fileContent.replace(/\/\*[\s\S]*?\*\//g, "");
  stripped = stripped.replace(/\/\/.*/g, "");
  try {
    return JSON.parse(stripped);
  } catch (e) {
    throw new Error(`Failed to parse JSONC config: ${(e as Error).message}`);
  }
}

export function getWorkspaceRoot(workingDirectory?: string) {
  if (workingDirectory) {
    return workingDirectory;
  }
  let current = import.meta.dirname;
  while (current !== "/" && !fsSync.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
    current = path.dirname(current);
  }
  return current === "/" ? process.cwd() : current;
}

export function loadOaConfig(configPath?: string): { workingDirectory?: string } {
  const resolvedPath = configPath
    ? path.isAbsolute(configPath)
      ? configPath
      : path.join(getWorkspaceRoot(), configPath)
    : DEFAULT_CONFIG_PATH;

  if (!fsSync.existsSync(resolvedPath)) {
    return {};
  }
  const content = fsSync.readFileSync(resolvedPath, "utf-8");
  return parseJsonc(content);
}

const args = process.argv.slice(2);
export let uiConfigPath: string | undefined = process.env["OA_CONFIG"];

// Fallback to argv parsing if no env var was provided
if (!uiConfigPath) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      uiConfigPath = args[i + 1];
      i++;
    }
  }
}

export const parsedConfig = loadOaConfig(uiConfigPath);

const parsedWorkDir = parsedConfig.workingDirectory;
export const workingDirectory = parsedWorkDir
  ? path.isAbsolute(parsedWorkDir)
    ? parsedWorkDir
    : path.join(getWorkspaceRoot(), parsedWorkDir)
  : path.join(getWorkspaceRoot(), "_");

export function getLogsDir() {
  return path.join(workingDirectory, "logs");
}

export async function getUserDataDir() {
  const { Utils } = await import("electrobun/bun");
  return Utils.paths.userData;
}

export async function getWatchedProjectsPath() {
  return path.join(await getUserDataDir(), "watched_projects.json");
}

export async function getRecentProjectsPath() {
  return path.join(await getUserDataDir(), "recent_projects.json");
}
