import { resolveLogsDir } from "../run-result-writer.js";

let override: string | null = null;

/** Test/CLI override. Pass `null` to clear back to the env-resolved default. */
export function setLogsDirectory(dir: string | null): void {
  override = dir;
}

/** Root for per-run log artifacts. Resolved fresh on each call so env overrides apply. */
export function getLogsDirectory(): string {
  return override ?? resolveLogsDir();
}
