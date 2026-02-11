import { sql } from "rwsdk/db";
import { getSpeccingDb, type SpeccingDatabase } from "../../databases/speccing";
import { getMomentDb, type MomentGraphContext, getMoment, getMoments } from "../../databases/momentGraph";
import { Moment, ChunkMetadata, IndexingHookContext, QueryHookContext } from "../../types";
import { createEngineContext } from "../../index";

export interface SpeccingSession {
  id: string;
  subjectId: string;
  priorityQueue: string[]; // Moment IDs
  processedIds: string[];
  workingSpec: string;
  replayTimestamp: string;
  momentGraphNamespace: string | null;
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
      moment_graph_namespace: context.momentGraphNamespace ?? null,
      status: "active",
      created_at: now,
      updated_at: now,
    })
    .execute();

  return sessionId;
}

export interface SpeccingSessionResult {
  status: 'active' | 'completed' | 'failed' | 'not_found';
  moment?: {
    id: string;
    title: string;
    summary: string;
    createdAt: string;
  };
  evidence?: {
    content: string;
    source: string;
    r2Key: string;
    diff?: string;
  };
  instruction?: string;
  workerUrl?: string;
}

export async function tickSpeccingSession(
  context: MomentGraphContext,
  sessionId: string
): Promise<SpeccingSessionResult> {
  const speccingDb = getSpeccingDb(context.env);
  type SpeccingDb = ReturnType<typeof getSpeccingDb>;
  const momentDb = getMomentDb(context);

  const session = await speccingDb
    .selectFrom("speccing_sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .executeTakeFirst();

  if (!session || session.status !== "active") {
    return { status: (session?.status as SpeccingSessionResult['status']) ?? "not_found" };
  }

  // Re-hydrate context with the persisted namespace
  const sessionNamespace = session.moment_graph_namespace ?? context.momentGraphNamespace;
  const hydratedContext: MomentGraphContext = {
    ...context,
    momentGraphNamespace: sessionNamespace
  };

  const parseJsonField = (field: string | null, defaultValue: string[] = []): string[] => {
    if (!field) return defaultValue;
    if (typeof field !== 'string') return defaultValue;
    
    try {
      const parsed = JSON.parse(field);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      // If it looks like a GUID, wrap it in an array
      if (field.includes('-') && field.length > 20) {
          return [field];
      }
      return defaultValue;
    }
  };

  const pq = parseJsonField(session.priority_queue_json);
  const processed = parseJsonField(session.processed_ids_json);

  if (pq.length === 0) {
    await speccingDb
      .updateTable("speccing_sessions")
      .set({ status: "completed", updated_at: new Date().toISOString() })
      .where("id", "=", sessionId)
      .execute();
    return { status: "completed" };
  }

  // Pop the earliest moment
  const currentMomentId = pq.shift()!;
  processed.push(currentMomentId);

  const moment = await getMoment(currentMomentId, hydratedContext);
  if (!moment) {
      console.warn(`[speccing] moment ${currentMomentId} disappeared from namespace ${sessionNamespace}, skipping.`);
      await updateSession(speccingDb, sessionId, pq, processed, session.working_spec, session.replay_timestamp);
      return tickSpeccingSession(hydratedContext, sessionId);
  }

  // Find children
  const momentDbForSession = getMomentDb(hydratedContext);
  const children = await momentDbForSession
    .selectFrom("moments")
    .select("id")
    .where("parent_id", "=", currentMomentId)
    .execute();

  const newPq = [...pq, ...children.map((c) => c.id)];

  // Update working spec (Self-Instructing narrative)
  const updatedSpec = session.working_spec + `## [Moment] ${moment.title}\n\n${moment.summary}\n\n`;

  // Fetch evidence
  const evidence = await fetchEvidenceForMoment(moment, hydratedContext);

  await updateSession(speccingDb, sessionId, newPq, processed, updatedSpec, moment.createdAt);

  return {
    status: "active",
    moment: {
      id: moment.id,
      title: moment.title,
      summary: moment.summary,
      createdAt: moment.createdAt,
    },
    evidence: evidence ?? undefined,
    instruction: `REPLAY TURN: Integrate the evidence into the spec. Focus on "${moment.title}". Once done, proceed to the next moment: curl -H "Authorization: Bearer $API_KEY" "$WORKER_URL/api/speccing/next?sessionId=${sessionId}"`,
  };
}

async function fetchEvidenceForMoment(
  moment: Moment,
  context: MomentGraphContext
): Promise<SpeccingSessionResult['evidence'] | null> {
  const r2Key = moment.sourceMetadata?.simulation?.r2Key;
  if (!r2Key) return null;

  try {
    const bucket = context.env.MACHINEN_BUCKET as R2Bucket;
    if (!bucket) {
      console.warn(`[speccing:evidence] MACHINEN_BUCKET not found in env`);
      return null;
    }

    const obj = await bucket.get(r2Key);
    if (!obj) {
      console.warn(`[speccing:evidence] R2 object not found: ${r2Key}`);
      return null;
    }

    const rawJson = await obj.json();
    const engineContext = createEngineContext(context.env, "querying");
    
    // Find matching plugin
    const plugin = engineContext.plugins.find(p => 
      r2Key.startsWith(p.name + "/") || 
      moment.sourceMetadata?.source === p.name
    );

    if (!plugin || !plugin.evidence || !plugin.evidence.reconstructContext) {
      console.warn(`[speccing:evidence] No matching plugin or reconstruction logic for ${r2Key}`);
      return null;
    }

    let timeLockedData = rawJson;
    if (plugin.evidence.timeTravel) {
      const indexingContext: IndexingHookContext = {
        r2Key,
        env: context.env,
        momentGraphNamespace: context.momentGraphNamespace,
        indexingMode: "replay"
      };
      timeLockedData = await plugin.evidence.timeTravel(rawJson, moment.createdAt, indexingContext);
    }

    if (!timeLockedData) {
      console.warn(`[speccing:evidence] Time travel returned null for ${r2Key} at ${moment.createdAt}`);
      return null;
    }

    const queryContext: QueryHookContext = {
      query: moment.summary,
      env: context.env,
      momentGraphNamespace: context.momentGraphNamespace
    };

    // Synthesize chunks from microPaths
    const microPaths = moment.microPaths || [];
    const syntheticChunks: ChunkMetadata[] = microPaths.map((path, i) => ({
      chunkId: `${moment.id}-${i}`,
      documentId: moment.documentId,
      source: plugin.name,
      type: "reconstructed-speccing-chunk",
      documentTitle: moment.title,
      author: moment.author,
      jsonPath: path,
      sourceMetadata: {
          ...moment.sourceMetadata,
          // Ensure type is preserved for github plugin
          type: moment.sourceMetadata?.type || moment.sourceMetadata?.github?.type
      },
    }));

    // If no microPaths, create a fallback chunk to ensure plugins like github (which check length) don't bail
    if (syntheticChunks.length === 0) {
        syntheticChunks.push({
            chunkId: `${moment.id}-fallback`,
            documentId: moment.documentId,
            source: plugin.name,
            type: "reconstructed-speccing-fallback",
            documentTitle: moment.title,
            author: moment.author,
            jsonPath: "$",
            sourceMetadata: {
                ...moment.sourceMetadata,
                type: moment.sourceMetadata?.type || moment.sourceMetadata?.github?.type
            },
        });
    }

    const reconstructed = await plugin.evidence.reconstructContext(syntheticChunks, timeLockedData, queryContext);
    if (!reconstructed) {
      console.warn(`[speccing:evidence] Reconstruction failed for ${r2Key}`);
      return null;
    }

    return {
      content: reconstructed.content,
      source: plugin.name,
      r2Key,
      diff: reconstructed.diff
    };
  } catch (error) {
    console.error(`[speccing:evidence] Error fetching evidence for ${r2Key}:`, error);
    return null;
  }
}

async function updateSession(
  db: ReturnType<typeof getSpeccingDb>,
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
