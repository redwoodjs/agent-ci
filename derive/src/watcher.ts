import chokidar from "chokidar";

export type WatchCallback = (jsonlPath: string) => void;

// Branch-scoped watcher. Watches a single slug directory (not all of
// ~/.claude/projects/). ignoreInitial=true because the caller runs an explicit
// discover+update cycle before starting the watcher — we only care about
// changes that happen after that point.
export function startWatcher(slugDir: string, onChange: WatchCallback): void {
  const watcher = chokidar.watch(slugDir, {
    persistent: true,
    ignoreInitial: true,
    ignored: (filePath: string, stats?: { isFile(): boolean }) =>
      stats?.isFile() === true && !filePath.endsWith(".jsonl"),
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on("add", onChange);
  watcher.on("change", onChange);
  watcher.on("error", (err) => {
    console.error("[watcher] error:", err);
  });

  console.log(`[watcher] watching ${slugDir}`);
}
