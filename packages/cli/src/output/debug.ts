import { minimatch } from "minimatch";

/**
 * Lightweight debug logger with namespace support.
 *
 * Enable via DEBUG env var with glob patterns:
 *   DEBUG=agent-ci:*        — all namespaces
 *   DEBUG=agent-ci:cli      — CLI only
 *   DEBUG=agent-ci:dtu      — DTU only
 *   DEBUG=agent-ci:runner   — Runner only
 *   DEBUG=agent-ci:cli,agent-ci:dtu — multiple
 *
 * Output goes to stderr so stdout stays clean for piping.
 */

const debugPatterns: string[] = (process.env.DEBUG || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isEnabled(namespace: string): boolean {
  return debugPatterns.some((pattern) => minimatch(namespace, pattern));
}

export function createDebug(namespace: string): (...args: unknown[]) => void {
  const enabled = isEnabled(namespace);
  if (!enabled) {
    return () => {};
  }

  const prefix = `  ${namespace}`;
  return (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    process.stderr.write(`${prefix} ${msg}\n`);
  };
}

// Pre-configured loggers for each domain
export const debugCli = createDebug("agent-ci:cli");
export const debugRunner = createDebug("agent-ci:runner");
export const debugDtu = createDebug("agent-ci:dtu");
export const debugBoot = createDebug("agent-ci:boot");
