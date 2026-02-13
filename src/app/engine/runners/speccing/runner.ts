import { sql } from "rwsdk/db";
import { getSpeccingDb, type SpeccingDatabase } from "../../databases/speccing";
import { getMomentDb, type MomentGraphContext, getMoment, getMoments } from "../../databases/momentGraph";
import { Moment, ChunkMetadata, IndexingHookContext, QueryHookContext } from "../../types";
import { createEngineContext } from "../../index";
import { callLLM } from "../../utils/llm";

async function reviseSpecTurn(
  context: MomentGraphContext,
  currentSpec: string,
  moment: Moment,
  evidence: SpeccingSessionResult['evidence'] | null,
  userPrompt?: string
): Promise<string> {
  const workerUrl = (context.env as any).MACHINEN_ENGINE_URL || "https://machinen.redwoodjs.workers.dev";
  const citationUrl = evidence?.r2Key ? `${workerUrl}/audit/ingestion/file/${evidence.r2Key}` : null;

  const prompt = `
# Role
You are the Machinen Speccing Actor (Technical Writer and Architect). Your role is to reassemble the historical development narrative provided by the Machinen Speccing Engine into an authoritative technical specification.

# Formatting Standard
- **Location**: Your output is a single markdown file.
- **Iteration**: This file is iteratively refined. Return the FULL updated specification.
- **Consensus Only**: Focus strictly on final consensus, settled decisions, and the "Definition of Done".
- **Source Citation**: Every design decision should be cited using the evidence source. ${citationUrl ? `Current turn citation URL: ${citationUrl}` : ""}
- **Tone**: Keep the tone professional, technical, and objective. Use "We" as the voice.

# Mandatory Spec Structure
Ensure the specification follows this structure:
1.  **2000ft View Narrative**: High-level architectural narrative.
2.  **Database Changes**: Schema changes and their rationale.
3.  **Behavior Spec**: Ground truth behaviors (GIVEN/WHEN/THEN).
4.  **Implementation Detail**: Breakdown of code changes (\`[NEW]\`, \`[MODIFY]\`, \`[DELETE]\`).
5.  **Directory & File Structure**: Tree view of files.
6.  **Types & Data Structures**: Snippets of types.
7.  **Invariants & Constraints**: Rules for the system.
8.  **System Flow (Snapshot Diff)**: Previous -> New flow delta.
9.  **Suggested Verification**: Commands/URLs for manual validation.
10. **Tasks**: Granular checklist.

# Current Specification Draft
${currentSpec}

# New Evidence: ${moment.title}
Summary: ${moment.summary}
Historical Context:
${evidence?.content || "No detailed evidence available."}
${evidence?.diff ? `Code Changes:\n\`\`\`diff\n${evidence.diff}\n\`\`\`` : ""}

${userPrompt ? `# User Guidance\n${userPrompt}` : ""}

# Action
Revise the current specification draft to incorporate the new evidence. Integrate the details into the appropriate sections according to the Mandatory Spec Structure. Ground all claims in the provided evidence.
`;

  return await callLLM(prompt, "cerebras-gpt-oss-120b", {
    reasoning: {
      effort: "high"
    }
  });
}

async function generateSemanticSessionId(
  title: string,
  summary: string
): Promise<string> {
  const prompt = `
Generate a short, URL-safe semantic identifier (kebab-case) for a speccing session.
The session is about: ${title}
Summary: ${summary}

Examples:
- "auth-refactor-api"
- "ui-component-library-v2"
- "data-migration-strategy"

Return ONLY the kebab-case identifier, no other text or explanation.
`;

  const result = await callLLM(prompt);
  // Clean up any accidental LLM output
  return result.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `session-${Date.now()}`;
}

export interface SpeccingSession {
  id: string;
  subjectId: string;
  priorityQueue: string[]; // Moment IDs
  processedIds: string[];
  workingSpec: string;
  revisionMode: 'server' | 'client';
  replayTimestamp: string;
  momentGraphNamespace: string | null;
  status: 'active' | 'completed' | 'failed';
}

export async function initializeSpeccingSession(
  context: MomentGraphContext,
  subjectId: string,
  revisionMode: 'server' | 'client' = 'server'
): Promise<string> {
  const speccingDb = getSpeccingDb(context.env);
  
  // Find the subject moment
  const subject = await getMoment(subjectId, context);
  if (!subject) {
    throw new Error(`Subject moment not found: ${subjectId}`);
  }

  const now = new Date().toISOString();
  const semanticId = await generateSemanticSessionId(subject.title, subject.summary);
  const sessionId = `${semanticId}-${Math.floor(Math.random() * 10000)}`;

  await speccingDb
    .insertInto("speccing_sessions")
    .values({
      id: sessionId,
      subject_id: subjectId,
      priority_queue_json: [subjectId] as any,
      processed_ids_json: [] as any,
      working_spec: `# Specification: ${subject.title}\n\n${subject.summary}\n\n`,
      revision_mode: revisionMode,
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
  revisedSpec?: string;
  instruction?: string;
  workerUrl?: string;
}

export async function tickSpeccingSession(
  context: MomentGraphContext,
  sessionId: string,
  userPrompt?: string
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

  // rwsdk/db auto-parses JSON columns
  const pq = [].concat((session.priority_queue_json as any || [])) as string[]
  const processed = [].concat((session.processed_ids_json as any || [])) as string[];

  console.log(`[speccing:next] Session ${sessionId} PQ type: ${typeof pq}, isArray: ${Array.isArray(pq)}`);
  console.log(`[speccing:next] PQ content:`, pq);

  if (pq.length === 0) {
    console.log(`[speccing:next] Session ${sessionId} completed (empty PQ)`);
    await speccingDb
      .updateTable("speccing_sessions")
      .set({ status: "completed", updated_at: new Date().toISOString() })
      .where("id", "=", sessionId)
      .execute();
    return { status: "completed" };
  }

  // Pop the earliest moment
  const currentMomentId = pq.shift();
  if (!currentMomentId) {
       // Should be unreachable given length check, but safe guard types
       return { status: "completed" };
  }
  processed.push(currentMomentId);

  const moment = await getMoment(currentMomentId, hydratedContext);
  if (!moment) {
      console.warn(`[speccing] moment ${currentMomentId} disappeared from namespace ${sessionNamespace}, skipping.`);
      await updateSession(speccingDb, sessionId, pq, processed, session.working_spec, session.replay_timestamp);
      return tickSpeccingSession(hydratedContext, sessionId, userPrompt);
  }

  // Find children
  const momentDbForSession = getMomentDb(hydratedContext);
  const children = await momentDbForSession
    .selectFrom("moments")
    .select("id")
    .where("parent_id", "=", currentMomentId)
    .execute();

  const newPq = [...pq, ...children.map((c) => c.id)];

  // Fetch evidence
  const evidence = await fetchEvidenceForMoment(moment, hydratedContext);

  let updatedSpec = session.working_spec;
  if (session.revision_mode === 'server') {
    console.log(`[speccing:next] Performing server-side revision for session ${sessionId}`);
    updatedSpec = await reviseSpecTurn(hydratedContext, session.working_spec, moment, evidence, userPrompt);
  } else {
    console.log(`[speccing:next] Client-side revision mode. Skipping server-side LLM call.`);
    // Fallback: append a marker for consistency in the working_spec
    updatedSpec = session.working_spec + `\n\n## [Moment] ${moment.title}\n\n${moment.summary}\n\n`;
  }

  await updateSession(speccingDb, sessionId, newPq, processed, updatedSpec, moment.createdAt);

  return {
    status: "active",
    moment: {
        id: moment.id,
        title: moment.title,
        summary: moment.summary,
        createdAt: moment.createdAt
    },
    evidence: evidence ?? undefined,
    revisedSpec: session.revision_mode === 'server' ? updatedSpec : undefined,
    instruction: session.revision_mode === 'server'
      ? `NEXT ACTIONS: 1. The specification has been revised. Save the revisedSpec to your local file. 2. Continue the loop by calling /next.`
      : `NEXT ACTIONS: 1. Update the specification locally using the provided evidence. 2. Continue the loop by calling /next.`,
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

    let rawJson: any;
    if (r2Key.endsWith(".jsonl")) {
      // For JSONL files, do not parse as a single JSON object
      // Pass the raw text to the plugin (e.g. Discord plugin handles this)
      rawJson = await obj.text();
    } else {
      rawJson = await obj.json();
    }
    console.log(`[speccing:evidence] Fetched raw JSON for ${r2Key}. Size: ${JSON.stringify(rawJson).length}`);
    const engineContext = createEngineContext(context.env, "querying");
    
    // Find matching plugin
    const plugin = engineContext.plugins.find(p => 
      r2Key.startsWith(p.name + "/") || 
      moment.sourceMetadata?.source === p.name
    );

    if (!plugin || !plugin.evidence || !plugin.evidence.reconstructContext) {
      console.warn(`[speccing:evidence] No matching plugin or reconstruction logic for ${r2Key}. Plugin found: ${plugin?.name}`);
      return null;
    }
    console.log(`[speccing:evidence] Selected plugin: ${plugin.name} for ${r2Key}`);

    let timeLockedData = rawJson;
    if (plugin.evidence.timeTravel) {
      console.log(`[speccing:evidence] Executing timeTravel for ${r2Key} at ${moment.createdAt}`);
      const indexingContext: IndexingHookContext = {
        r2Key,
        env: context.env,
        momentGraphNamespace: context.momentGraphNamespace,
        indexingMode: "replay"
      };
      timeLockedData = await plugin.evidence.timeTravel(rawJson, moment.createdAt, indexingContext);
    }

    if (!timeLockedData) {
      console.warn(`[speccing:evidence] timeTravel returned null for ${r2Key}`);
      return null;
    }

    const queryContext: QueryHookContext = {
      query: moment.summary,
      env: context.env,
      momentGraphNamespace: context.momentGraphNamespace
    };

    let sourceType = moment.sourceMetadata?.type || moment.sourceMetadata?.github?.type;
    
    // Polyfill missing type based on R2 key patterns
    if (!sourceType) {
        if (plugin.name === 'discord') {
             if (r2Key.includes('/threads/')) sourceType = 'discord-thread';
             else sourceType = 'discord-channel';
        } else if (plugin.name === 'github') {
             if (r2Key.includes('/issues/') || r2Key.includes('/pull/') || r2Key.includes('/pull-requests/')) sourceType = 'github-pr-issue';
             else if (r2Key.includes('/projects/')) sourceType = 'github-project';
        }
    }
    
    console.log(`[speccing:evidence] Inferred sourceType '${sourceType}' for ${r2Key} (plugin: ${plugin.name})`);

    // Request the full document content from the plugin
    // We use a specific "full-document" chunk to trigger the plugin's complete rendering logic
    const fullDocumentRequest: ChunkMetadata[] = [{
        chunkId: "full-doc",
        documentId: moment.documentId,
        source: plugin.name,
        type: "full-document",
        documentTitle: moment.title,
        author: moment.author,
        jsonPath: "$.", // Request root
        sourceMetadata: {
            ...moment.sourceMetadata,
            type: sourceType
        },
    }];

    console.log(`[speccing:evidence] Calling reconstructContext for full document.`);

    const reconstructed = await plugin.evidence.reconstructContext(fullDocumentRequest, timeLockedData, queryContext);
    
    console.log(`[speccing:evidence] Reconstruction result for ${r2Key}:`, reconstructed ? `Content length: ${reconstructed.content.length}` : "null");

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
      priority_queue_json: pq as any,
      processed_ids_json: processed as any,
      working_spec: spec,
      replay_timestamp: timestamp,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", id)
    .execute();
}
