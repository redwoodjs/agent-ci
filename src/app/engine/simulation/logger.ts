import type { SimulationDbContext } from "./types";
import { addSimulationRunEvent } from "./runEvents";

export function createSimulationRunLogger(
  context: SimulationDbContext,
  input: { runId: string; persistInfo?: boolean }
): {
  error: (kind: string, payload: Record<string, any>) => Promise<void>;
  warn: (kind: string, payload: Record<string, any>) => Promise<void>;
  info: (kind: string, payload: Record<string, any>) => Promise<void>;
  debug: (kind: string, payload: Record<string, any>) => Promise<void>;
} {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  const verbosityRaw = String(
    (context.env as any).MACHINEN_SIMULATION_EVENT_VERBOSITY ?? ""
  )
    .trim()
    .toLowerCase();
  
  const isVerbose =
    verbosityRaw === "1" ||
    verbosityRaw === "true" ||
    verbosityRaw === "verbose" ||
    verbosityRaw === "item";

  // Default to persisting info unless explicitly disabled
  const persistInfo = input.persistInfo !== false;

  return {
    async error(kind, payload) {
      console.error(`[simulation:${runId}] ${kind}`, payload);
      await addSimulationRunEvent(context, {
        runId,
        level: "error",
        kind,
        payload,
      });
    },
    async warn(kind, payload) {
      console.warn(`[simulation:${runId}] ${kind}`, payload);
      await addSimulationRunEvent(context, {
        runId,
        level: "warn",
        kind,
        payload,
      });
    },
    async info(kind, payload) {
      if (persistInfo) {
        await addSimulationRunEvent(context, {
          runId,
          level: "info",
          kind,
          payload,
        });
      }
    },
    async debug(kind, payload) {
      if (isVerbose) {
        await addSimulationRunEvent(context, {
          runId,
          level: "debug",
          kind,
          payload,
        });
      }
    },
  };
}

