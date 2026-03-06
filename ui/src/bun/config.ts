import path from "node:path";
import fsSync from "node:fs";

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

export const workingDirectory = process.env["MACHINEN_WORKING_DIR"]
  ? path.isAbsolute(process.env["MACHINEN_WORKING_DIR"])
    ? process.env["MACHINEN_WORKING_DIR"]
    : path.join(getWorkspaceRoot(), process.env["MACHINEN_WORKING_DIR"])
  : path.join(getWorkspaceRoot(), "_");

export function getLogsDir() {
  return path.join(workingDirectory, "logs");
}

export async function getUserDataDir() {
  const { Utils } = await import("electrobun/bun");
  return Utils.paths.userData;
}

export async function getWatchedReposPath() {
  return path.join(await getUserDataDir(), "watched_repos.json");
}

export async function getRecentReposPath() {
  return path.join(await getUserDataDir(), "recent_repos.json");
}
