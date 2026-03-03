import chokidar from "chokidar";
import path from "node:path";
import os from "node:os";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export type WatchCallback = (jsonlPath: string) => void;

export function startWatcher(onChange: WatchCallback): void {
  // --awaitWriteFinish debounces at
  // the FS level to avoid partial-read races on active writes.
  const watcher = chokidar.watch(CLAUDE_PROJECTS_DIR, {
    persistent: true,
    ignoreInitial: false,
    ignored: (filePath: string, stats?: { isFile(): boolean }) =>
      stats?.isFile() === true && !filePath.endsWith(".jsonl"),
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("error", (err) => {
    console.error("[watcher] error:", err);
  });

  console.log(`[watcher] watching ${CLAUDE_PROJECTS_DIR}`);
}
