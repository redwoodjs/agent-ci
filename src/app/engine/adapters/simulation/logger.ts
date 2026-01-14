import type { SimulationDbContext } from "./types";
import { addSimulationRunEvent } from "./runEvents";

export function createSimulationRunLogger(
  context: SimulationDbContext,
  input: { runId: string; persistInfo?: boolean }
): {
  error: (kind: string, payload: Record<string, any>) => Promise<void>;
  warn: (kind: string, payload: Record<string, any>) => Promise<void>;
  info: (kind: string, payload: Record<string, any>) => Promise<void>;
} {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  const persistInfo =
    input.persistInfo === true ||
    String((context.env as any).SIMULATION_AUDIT_PERSIST_INFO ?? "") === "1";

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
  };
}

