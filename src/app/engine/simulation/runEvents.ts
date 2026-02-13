import type {
  SimulationDbContext,
  SimulationRunEventLevel,
  SimulationRunEventRow,
} from "./types";
import { getSimulationDb } from "./db";

export async function addSimulationRunEvent(
  context: SimulationDbContext,
  input: {
    runId: string;
    level: SimulationRunEventLevel;
    kind: string;
    payload: Record<string, any>;
    r2Key?: string;
  }
): Promise<void> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return;
  }
  const kind =
    typeof input.kind === "string" && input.kind.length > 0 ? input.kind : "event";
  const level: SimulationRunEventLevel =
    input.level === "debug" ||
    input.level === "info" ||
    input.level === "warn" ||
    input.level === "error"
      ? input.level
      : "info";
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db
    .insertInto("simulation_run_events")
    .values({
      id,
      run_id: runId,
      level,
      kind,
      payload_json: JSON.stringify(input.payload ?? {}),
      created_at: now,
    })
    .execute();

}

export async function getSimulationRunEvents(
  context: SimulationDbContext,
  input: { runId: string; limit?: number; sort?: "asc" | "desc" }
): Promise<
  Array<{
    id: string;
    level: string;
    kind: string;
    createdAt: string;
    payload: any;
  }>
> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return [];
  }
  const limitRaw = input.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(50000, Math.floor(limitRaw))
      : 2000;

  const sort = input.sort === "asc" ? "asc" : "desc";

  const rows = (await db
    .selectFrom("simulation_run_events")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("created_at", sort)
    .limit(limit)
    .execute()) as unknown as SimulationRunEventRow[];

  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    kind: r.kind,
    createdAt: r.created_at,
    payload: r.payload_json ?? {},
  }));
}

