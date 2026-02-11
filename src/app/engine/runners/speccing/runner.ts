import { sql } from "rwsdk/db";
import { getSpeccingDb, type SpeccingDatabase } from "../../databases/speccing";
import { getMomentDb, type MomentGraphContext, getMoment, getMoments } from "../../databases/momentGraph";
import { Moment } from "../../types";
import { createEngineContext } from "../../index";

export interface SpeccingSession {
  id: string;
  subjectId: string;
  momentGraphNamespace: string;
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
      moment_graph_namespace: context.momentGraphNamespace,
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
  env: Cloudflare.Env,
  sessionId: string,
  baseUrl: string
): Promise<any> {
  const speccingDb = getSpeccingDb(env);

  const session = await speccingDb
    .selectFrom("speccing_sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .executeTakeFirst();

  if (!session || session.status !== "active") {
    return { status: session?.status ?? "not_found" };
  }

  // Re-hydrate MomentGraphContext from persisted namespace
  const context: MomentGraphContext = {
    env: env as any,
    momentGraphNamespace: session.moment_graph_namespace || null,
  };
  const momentDb = getMomentDb(context);

  console.log("[speccing] tick session", {
    id: sessionId,
    namespace: context.momentGraphNamespace,
    pq_raw: session.priority_queue_json,
  });

  // Handle auto-parsing vs string
  const pq: string[] = typeof session.priority_queue_json === 'string' 
    ? JSON.parse(session.priority_queue_json) 
    : session.priority_queue_json;
    
  const processed: string[] = typeof session.processed_ids_json === 'string'
    ? JSON.parse(session.processed_ids_json)
    : session.processed_ids_json;

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

  const moment = await getMoment(currentMomentId, context);
  if (!moment) {
      console.warn(`[speccing] moment ${currentMomentId} not found in namespace ${context.momentGraphNamespace}, skipping.`);
      await updateSession(speccingDb, sessionId, pq, processed, session.working_spec, session.replay_timestamp);
      return tickSpeccingSession(env, sessionId, baseUrl);
  }

  // RECONSTRUCT HIGH-FIDELITY EVIDENCE
  const engineContext = createEngineContext(env, "querying");
  let evidence: any[] = [];
  try {
    console.log(`[speccing] Attempting reconstruction for moment ${moment.id}, doc: ${moment.documentId}`);
    const docResponse = await env.MACHINEN_BUCKET.get(moment.documentId);
    if (!docResponse) {
      console.warn(`[speccing] R2 document missing: ${moment.documentId}`);
    } else {
      const docText = await docResponse.text();
      console.log(`[speccing] Fetched R2 text for ${moment.documentId}, length: ${docText.length}, start: ${docText.slice(0, 50).replace(/\n/g, "\\n")}`);
      
      let rawDoc: any;
      try {
        if (docText.trim().startsWith("{") && !docText.trim().includes("\n{")) {
          rawDoc = JSON.parse(docText);
        } else {
          // Attempt JSONL parsing
          const lines = docText.split("\n").filter(l => l.trim());
          if (lines.length > 1) {
            rawDoc = lines.map(l => JSON.parse(l));
          } else {
            rawDoc = JSON.parse(docText);
          }
        }
      } catch (parseErr) {
        console.error(`[speccing] failed to parse R2 document ${moment.documentId} as JSON/JSONL. First 200 chars: ${docText.slice(0, 200)}`, parseErr);
        throw parseErr;
      }
      
      // Get chunk metadata for this moment
      let chunks: any[] = [];
      const momentEvidenceRaw = (moment as any).momentEvidence;
      const chunkIds = typeof momentEvidenceRaw === 'string' ? JSON.parse(momentEvidenceRaw) : momentEvidenceRaw;
      
      console.log(`[speccing] Moment evidence IDs:`, chunkIds);

      if (Array.isArray(chunkIds) && chunkIds.length > 0) {
        const vectorizeResults = await (env as any).MOMENT_INDEX.getByIds(chunkIds);
        chunks = (vectorizeResults || []).map((r: any) => r.metadata);
        console.log(`[speccing] Re-hydrated chunks count: ${chunks.length}`);
      }

      // Find matching plugin and reconstruct
      const plugin = engineContext.plugins.find((p: any) => 
        p.name === (moment.sourceMetadata as any)?.plugin || 
        (rawDoc as any).source === p.name ||
        (Array.isArray(rawDoc) && rawDoc[0]?.source === p.name) ||
        moment.documentId.startsWith(`${p.name}/`) // Infer from R2 key prefix
      );

      if (plugin) {
        console.log(`[speccing] Matched plugin: ${plugin.name}`);

        // FALLBACK: If chunks are empty but we have chunkIds (semantic labels), try to find them in the document
        if (chunks.length === 0 && Array.isArray(chunkIds) && chunkIds.length > 0) {
          console.log(`[speccing] Chunks empty, attempting synthetic reconstruction from labels:`, chunkIds);
          // Try to find semantic labels in the document body or comments
          const allText = typeof rawDoc === 'string' ? rawDoc : JSON.stringify(rawDoc);
          for (const label of chunkIds) {
            if (typeof label === 'string' && allText.toLowerCase().includes(label.toLowerCase())) {
              // Create a synthetic chunk for the plugin to process
              chunks.push({
                chunkId: `synthetic-${crypto.randomUUID()}`,
                documentId: moment.documentId,
                source: plugin.name,
                type: "synthetic",
                content: label,
                sourceMetadata: (moment.sourceMetadata as any) || {}
              });
            }
          }
          console.log(`[speccing] Synthetic chunks created: ${chunks.length}`);
        }

        if (plugin?.evidence?.timeTravel && plugin?.evidence?.reconstructContext) {
          const historizedDoc = await plugin.evidence.timeTravel(rawDoc, moment.createdAt, {
            env: env as any,
            r2Key: moment.documentId
          });
          
          const reconstructed = await plugin.evidence.reconstructContext(chunks, historizedDoc, {
            env: env as any,
            clientContext: {},
            query: ""
          });

          if (reconstructed) {
            evidence.push(reconstructed);
            console.log(`[speccing] Successfully reconstructed evidence for ${moment.id}`);
          } else {
            console.warn(`[speccing] Plugin ${plugin.name} returned null for reconstruction`);
          }
        } else {
          console.warn(`[speccing] Plugin ${plugin.name} missing timeTravel or reconstructContext hooks`);
        }
      } else {
        console.warn(`[speccing] No plugin found for document ${moment.documentId}. Source metadata:`, moment.sourceMetadata);
      }
    }
  } catch (err) {
    console.error(`[speccing] failed to reconstruct high-fidelity evidence for ${moment.id}:`, err);
  }

  // Find children
  const children = await momentDb
    .selectFrom("moments")
    .select("id")
    .where("parent_id", "=", currentMomentId)
    .execute();

  const newPq = [...pq, ...children.map((c: any) => c.id)];

  // Update working spec
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
    evidence: evidence.length > 0 ? evidence : undefined,
    instruction: `REPLAY TURN: Integrate the evidence into the spec. Focus on "${moment.title}". Once done, proceed to the next moment: curl -H "Authorization: Bearer dev" "${baseUrl}/api/speccing/next?sessionId=${sessionId}"`,
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
