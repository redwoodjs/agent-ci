import { sql } from "rwsdk/db";
import { getSpeccingDb, type SpeccingDatabase } from "../../databases/speccing";
import { getMomentDb, type MomentGraphContext, getMoment, getMoments } from "../../databases/momentGraph";
import { Moment } from "../../types";

export interface SpeccingSession {
  id: string;
  subjectId: string;
  priorityQueue: string[]; // Moment IDs
  processedIds: string[];
  workingSpec: string;
  replayTimestamp: string;
  status: 'active' | 'completed' | 'failed';
}

export async function initializeSpeccingSession(
  context: MomentGraphContext,
  subjectId: string
): Promise<string> {
  const speccingDb = getSpeccingDb(context.env);
  const momentDb = getMomentDb(context);
  
  // Find the subject moment
  const subject = await getMoment(subjectId, context);
  if (!subject) {
    throw new Error(`Subject moment not found: ${subjectId}`);
  }

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();

  await speccingDb
    .insertInto("speccing_sessions")
    .values({
      id: sessionId,
      subject_id: subjectId,
      priority_queue_json: JSON.stringify([subjectId]),
      processed_ids_json: JSON.stringify([]),
      working_spec: `# Specification: ${subject.title}\n\n${subject.summary}\n\n`,
      replay_timestamp: subject.createdAt,
      status: "active",
      created_at: now,
      updated_at: now,
    })
    .execute();

  return sessionId;
}

export async function tickSpeccingSession(
  context: MomentGraphContext,
  sessionId: string
): Promise<any> {
  const speccingDb = getSpeccingDb(context.env);
  const momentDb = getMomentDb(context);

  const session = await speccingDb
    .selectFrom("speccing_sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .executeTakeFirst();

  if (!session || session.status !== "active") {
    return { status: session?.status ?? "not_found" };
  }

  const pq: string[] = JSON.parse(session.priority_queue_json);
  const processed: string[] = JSON.parse(session.processed_ids_json);

  if (pq.length === 0) {
    await speccingDb
      .updateTable("speccing_sessions")
      .set({ status: "completed", updated_at: new Date().toISOString() })
      .where("id", "=", sessionId)
      .execute();
    return { status: "completed" };
  }

  // Pop the earliest moment (PQ should be sorted by original timestamp if possible, 
  // but for now we just take the first in a breadth-first or depth-first manner. 
  // Breadth-first is safer for narrative).
  const currentMomentId = pq.shift()!;
  processed.push(currentMomentId);

  const moment = await getMoment(currentMomentId, context);
  if (!moment) {
      // Skip if moment disappeared
      await updateSession(speccingDb, sessionId, pq, processed, session.working_spec, session.replay_timestamp);
      return tickSpeccingSession(context, sessionId);
  }

  // Find children (moments pointing to this as parent)
  const children = await momentDb
    .selectFrom("moments")
    .select("id")
    .where("parent_id", "=", currentMomentId)
    .execute();

  const newPq = [...pq, ...children.map((c: any) => (c as any).id)];

  // Update working spec (Self-Instructing narrative)
  const updatedSpec = session.working_spec + `## [Moment] ${moment.title}\n\n${moment.summary}\n\n`;

  await updateSession(speccingDb, sessionId, newPq, processed, updatedSpec, moment.createdAt);

  return {
    status: "active",
    moment: {
      id: moment.id,
      title: moment.title,
      summary: moment.summary,
      createdAt: moment.createdAt,
    },
    instruction: `We just replayed: "${moment.title}".\n\nSummary: ${moment.summary}\n\nYour task is to integrate this narrative into the spec and reconcile any code snapshots as of ${moment.createdAt}.`,
    next_command: `curl -H "Authorization: Bearer $API_KEY" "$WORKER_URL/api/speccing/next?sessionId=${sessionId}"`
  };
}

async function updateSession(
  db: any,
  id: string,
  pq: string[],
  processed: string[],
  spec: string,
  timestamp: string
) {
  await db
    .updateTable("speccing_sessions")
    .set({
      priority_queue_json: JSON.stringify(pq),
      processed_ids_json: JSON.stringify(processed),
      working_spec: spec,
      replay_timestamp: timestamp,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", id)
    .execute();
}
