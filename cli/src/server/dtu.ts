import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "../working-directory.js";
import { broadcastEvent } from "./events.js";

const execAsync = promisify(execFile);

// ─── DTU process state ────────────────────────────────────────────────────────

let dtuProcess: ReturnType<typeof spawn> | null = null;
let dtuStatus: "Stopped" | "Starting" | "Running" | "Failed" | "Error" = "Stopped";

function setDtuStatus(newStatus: typeof dtuStatus) {
  if (dtuStatus !== newStatus) {
    dtuStatus = newStatus;
    broadcastEvent("dtuStatusChanged", { status: dtuStatus });
  }
}

// ─── Readiness check (overridable for tests) ──────────────────────────────────

/**
 * Override the readiness check used by startDtu().
 * In tests, inject a function that resolves immediately (or after a short delay)
 * so the test doesn't need an actual service running on port 8910.
 *
 * @example
 *   // In a vitest test:
 *   setDtuReadinessCheck(() => Promise.resolve(true));
 */
let dtuReadinessCheck: () => Promise<boolean> = async () => {
  try {
    const res = await fetch("http://localhost:8910").catch(() => null);
    return !!(res && res.ok);
  } catch {
    return false;
  }
};

export function setDtuReadinessCheck(fn: () => Promise<boolean>) {
  dtuReadinessCheck = fn;
}

// ─── Process spawner (overridable for tests) ──────────────────────────────────

type SpawnFn = typeof spawn;

function defaultDtuSpawner(): ReturnType<SpawnFn> {
  const rootCwd = PROJECT_ROOT;
  console.log(`[DTU] Starting dtu-github-actions from ${rootCwd}`);
  return spawn("pnpm", ["--filter", "dtu-github-actions", "dev"], {
    cwd: rootCwd,
    env: process.env,
    stdio: "pipe",
  });
}

let dtuSpawner: () => ReturnType<SpawnFn> = defaultDtuSpawner;

/**
 * Override the process spawner used by startDtu().
 * In tests, inject a factory that returns a controllable mock process.
 *
 * @example
 *   // In a vitest test:
 *   const { EventEmitter } = await import("node:events");
 *   setDtuSpawner(() => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); return p as any; });
 */
export function setDtuSpawner(fn: () => ReturnType<SpawnFn>) {
  dtuSpawner = fn;
}

// ─── Test reset ───────────────────────────────────────────────────────────────

/** Reset DTU state for use in tests. Clears any live process reference and resets status to Stopped. */
export function resetDtuStateForTest() {
  if (dtuProcess) {
    try {
      dtuProcess.kill();
    } catch {}
  }
  dtuProcess = null;
  dtuStatus = "Stopped";
  dtuReadinessCheck = async () => {
    try {
      const res = await fetch("http://localhost:8910").catch(() => null);
      return !!(res && res.ok);
    } catch {
      return false;
    }
  };
  dtuSpawner = defaultDtuSpawner;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getDtuStatus() {
  // Only verify reachability when we believe Running but have no live process
  // (i.e. the process reference has been lost but status wasn't updated).
  // When dtuProcess is non-null the process is authoritative.
  if (dtuStatus === "Running" && !dtuProcess) {
    try {
      const reachable = await dtuReadinessCheck();
      if (!reachable) {
        setDtuStatus("Failed");
      }
    } catch {
      setDtuStatus("Failed");
    }
  }
  return dtuStatus;
}

export async function startDtu() {
  if (dtuProcess || dtuStatus === "Running" || dtuStatus === "Starting") {
    return;
  }
  setDtuStatus("Starting");

  dtuProcess = dtuSpawner();

  dtuProcess.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[DTU] ${data.toString()}`);
  });

  dtuProcess.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[DTU Error] ${data.toString()}`);
  });

  dtuProcess.on("error", (err) => {
    console.error(`[DTU] Failed to start: ${err.message}`);
    dtuProcess = null;
    setDtuStatus("Failed");
  });

  dtuProcess.on("close", (code) => {
    console.log(`[DTU] Process exited with code ${code}`);
    dtuProcess = null;
    if (code !== 0 && code !== null) {
      setDtuStatus("Failed");
    } else {
      setDtuStatus("Stopped");
    }
  });

  // Poll using the (potentially overridden) readiness check instead of a fixed timeout
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!dtuProcess) {
      // Process already exited
      return;
    }
    try {
      const ready = await dtuReadinessCheck();
      if (ready) {
        console.log(`[DTU] Readiness check passed, DTU is running`);
        setDtuStatus("Running");
        return;
      }
    } catch {}
  }

  // If we get here, the DTU didn't respond in time
  if (dtuProcess) {
    console.error(`[DTU] Readiness check failed after ${maxAttempts * 500}ms`);
    setDtuStatus("Failed");
  }
}

export async function stopDtu() {
  if (dtuProcess) {
    dtuProcess.kill();
    dtuProcess = null;
    setDtuStatus("Stopped");
  } else {
    // Failsafe in case it was started by another daemon
    try {
      await execAsync("lsof", ["-t", "-i", ":8910"]).then(({ stdout }) => {
        if (stdout) {
          execAsync("kill", ["-9", ...stdout.trim().split("\n")]);
        }
      });
    } catch {}
    setDtuStatus("Stopped");
  }
}
