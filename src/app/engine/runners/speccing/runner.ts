import { sql } from "rwsdk/db";
import { getSpeccingDb, type SpeccingDatabase } from "../../databases/speccing";
import { getMomentDb, type MomentGraphContext, getMoment, getMoments } from "../../databases/momentGraph";
import { Moment, ChunkMetadata, IndexingHookContext, QueryHookContext } from "../../types";
import { createEngineContext } from "../../index";
import { callLLM, streamLLM } from "../../utils/llm";

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

async function draftSpec(
  context: MomentGraphContext,
  subject: Moment,
  userPrompt: string
): Promise<string> {
  const workerUrl = (context.env as any).MACHINEN_ENGINE_URL || "https://machinen.redwoodjs.workers.dev";
  const citationUrl = subject.sourceMetadata?.simulation?.r2Key ? `${workerUrl}/audit/ingestion/file/${subject.sourceMetadata.simulation.r2Key}` : null;

  const prompt = `
# Role
You are the Machinen Speccing Actor (Technical Writer and Architect). Your role is to reassemble the historical development narrative provided by the Machinen Speccing Engine into an authoritative technical specification.

# Task: Initial Drafting
Your goal is to construct the FIRST draft of the technical specification based purely on the user's initial prompt and the high-level subject metadata. 

# Formatting Standard
- **Location**: Your output is a single markdown file.
- **Consensus Only**: Focus strictly on final consensus, settled decisions, and the "Definition of Done".
- **Source Citation**: Cite the subject moment. ${citationUrl ? `Citation URL: ${citationUrl}` : ""}
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

# User Prompt (THE SOURCE OF TRUTH FOR THIS DRAFT)
${userPrompt}

# Subject Metadata
Title: ${subject.title}
Summary: ${subject.summary}

# Action
Generate the FULL initial technical specification draft. Follow the Mandatory Spec Structure strictly. Use placeholders or "[To be refined]" for sections where details are currently unknown but likely to be revealed in the historical narrative (moments).
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

  const result = await callLLM(prompt, "cerebras-gpt-oss-120b");
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
  revisionMode: 'server' | 'client' = 'server',
  proposedSessionId?: string
): Promise<string> {
  const speccingDb = getSpeccingDb(context.env);
  
  // Find the subject moment
  const subject = await getMoment(subjectId, context);
  if (!subject) {
    throw new Error(`Subject moment not found: ${subjectId}`);
  }

  const now = new Date().toISOString();
  let sessionId = proposedSessionId;
  
  if (!sessionId) {
    const semanticId = await generateSemanticSessionId(subject.title, subject.summary);
    sessionId = `${semanticId}-${Math.floor(Math.random() * 10000)}`;
  }

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

export interface SpeccingTurnContext {
  status: 'active' | 'completed' | 'not_found';
  session?: any;
  moment?: Moment;
  evidence?: SpeccingSessionResult['evidence'] | null;
  hydratedContext?: MomentGraphContext;
  fullPrompt?: string;
  isFirstTurn?: boolean;
  newPq?: string[];
  processed?: string[];
  speccingDb?: ReturnType<typeof getSpeccingDb>;
}

async function prepareSpeccingTurn(
  context: MomentGraphContext,
  sessionId: string,
  userPrompt?: string
): Promise<SpeccingTurnContext> {
  const { env } = context;
  const speccingDb = getSpeccingDb(env as any);

  const session = await speccingDb
    .selectFrom("speccing_sessions")
    .where("id", "=", sessionId)
    .selectAll()
    .executeTakeFirst();

  if (!session || session.status !== "active") {
    return { status: (session?.status as any) ?? "not_found" };
  }

  // Re-hydrate context with the persisted namespace
  const sessionNamespace = session.moment_graph_namespace ?? context.momentGraphNamespace;
  const hydratedContext: MomentGraphContext = { 
    ...context, 
    momentGraphNamespace: sessionNamespace
  };

  const pq = [].concat((session.priority_queue_json as any || [])) as string[];
  const processed = [].concat((session.processed_ids_json as any || [])) as string[];

  if (pq.length === 0) {
    // Mark as completed in DB if not already
    await speccingDb
      .updateTable("speccing_sessions")
      .set({ status: "completed", updated_at: new Date().toISOString() })
      .where("id", "=", sessionId)
      .execute();
    return { status: "completed" };
  }

  const isFirstTurn = processed.length === 0;
  const currentMomentId = pq.shift()!;
  
  // Safety check: if currentMomentId is undefined despite length check, return completed
  if (!currentMomentId) return { status: "completed" };

  processed.push(currentMomentId);

  // Find children and update PQ (Traversal Logic)
  const nextPq = await queueDescendants(hydratedContext, currentMomentId, pq);

  // Persist queue advancement immediately so we don't loop on failure
  await updateSessionProgress(speccingDb, sessionId, nextPq, processed);

  const moment = await getMoment(currentMomentId, hydratedContext);
  if (!moment) {
    console.warn(`[speccing] moment ${currentMomentId} disappeared from namespace ${sessionNamespace}, skipping.`);
    // Recursively skip this moment
    return prepareSpeccingTurn(context, sessionId, userPrompt);
  }

  const evidence = await fetchEvidenceForMoment(moment, hydratedContext);

  const workerUrl = (context.env as any).MACHINEN_ENGINE_URL || "https://machinen.redwoodjs.workers.dev";
  const fullPrompt = isFirstTurn && userPrompt 
    ? constructDraftPrompt(workerUrl, moment, userPrompt)
    : constructRevisePrompt(workerUrl, session.working_spec, moment, evidence, userPrompt);

  return {
    status: "active",
    session,
    moment,
    evidence: evidence ?? null,
    hydratedContext,
    fullPrompt,
    isFirstTurn,
    newPq: nextPq,
    processed,
    speccingDb
  };
}

export async function tickSpeccingSession(
  context: MomentGraphContext,
  sessionId: string,
  userPrompt?: string
): Promise<SpeccingSessionResult> {
  const prep = await prepareSpeccingTurn(context, sessionId, userPrompt);

  if (prep.status !== "active") {
    return { status: prep.status as any };
  }

  const { session, moment, evidence, fullPrompt, isFirstTurn, newPq, processed, speccingDb, hydratedContext } = prep;

  let updatedSpec = session!.working_spec;
  if (session!.revision_mode === 'server') {
     console.log(`[speccing:next] Calling LLM (non-streaming) for session ${sessionId}`);
     updatedSpec = await callLLM(fullPrompt!, "cerebras-gpt-oss-120b", {
        reasoning: { effort: "high" }
     });
  } else {
     console.log(`[speccing:next] Client mode, skipping LLM.`);
     updatedSpec = session!.working_spec + `\n\n## [Moment] ${moment!.title}\n\n${moment!.summary}\n\n`;
  }

  await updateSession(speccingDb!, sessionId, newPq!, processed!, updatedSpec, moment!.createdAt);

  return {
    status: "active",
    moment: {
        id: moment!.id,
        title: moment!.title,
        summary: moment!.summary,
        createdAt: moment!.createdAt
    },
    evidence: evidence ?? undefined,
    revisedSpec: session!.revision_mode === 'server' ? updatedSpec : undefined,
    instruction: session!.revision_mode === 'server'
      ? (isFirstTurn ? `DRAFTING COMPLETE: Initial specification drafted. Proceeding to refine.` : `NEXT ACTIONS: Save revisedSpec locally. Continue loop.`)
      : `NEXT ACTIONS: Update locally with evidence. Continue loop.`,
  };
}

/**
 * Optimized raw text streaming for Cloudflare Workers.
 * Emits metadata as a JSON header, then streams the raw spec body.
 */
export async function tickSpeccingSessionStream(
  context: MomentGraphContext,
  sessionId: string,
  userPrompt?: string,
  ctx?: { waitUntil: (promise: Promise<any>) => void }
): Promise<Response> {
  const prep = await prepareSpeccingTurn(context, sessionId, userPrompt);

  if (prep.status !== "active") {
    if (prep.status === "completed") return Response.json({ status: "completed" });
    return Response.json({ error: `Session status: ${prep.status}` }, { status: 404 });
  }

  const { session, moment, fullPrompt, newPq, processed, speccingDb, isFirstTurn } = prep;

  console.log(`[speccing:stream] Prompt constructed. Length: ${fullPrompt!.length}. Calling streamLLM...`);
  
  const result = await streamLLM(fullPrompt!, "cerebras-gpt-oss-120b", { 
    reasoning: { effort: "high" },
    onFinish: async (finalPayload) => {
        const updatePromise = (async () => {
            try {
                await updateSession(speccingDb!, sessionId, newPq!, processed!, finalPayload, moment!.createdAt);
                console.log(`[speccing:stream] Session ${sessionId} turn complete and persisted.`);
            } catch (err) {
                console.error(`[speccing:stream] FAILED to persist session ${sessionId}:`, err);
            }
        })();
        if (ctx) {
            ctx.waitUntil(updatePromise);
        } else {
            console.warn(`[speccing:stream] No ExecutionContext provided, update might be killed.`);
            void updatePromise;
        }
    }
  });

  console.log(`[speccing:stream] streamLLM returned result object. Initiating response...`);

  const metadata = {
    status: "active",
    moment: {
      id: moment!.id,
      title: moment!.title,
      summary: moment!.summary,
      createdAt: moment!.createdAt
    },
    isFirstTurn
  };

  console.log(`[speccing:stream] Returning TextStreamResponse for session ${sessionId}. Metadata: ${JSON.stringify(metadata)}`);

  // Add headers to discourage buffering in proxies/servers
  const baseResponse = result.toTextStreamResponse({
    headers: {
        "x-speccing-metadata": Buffer.from(JSON.stringify(metadata)).toString('base64'),
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive"
    },
  });

  // Add chunk logging to verify data flow
  let chunkCount = 0;
  let totalLength = 0;
  const streamStartTime = Date.now();
  const loggingStream = new TransformStream({
    transform(chunk, controller) {
      chunkCount++;
      totalLength += chunk.length;
      // const now = Date.now();
      // console.log(`[speccing:stream] Chunk ${chunkCount} sent (+${now - streamStartTime}ms). Length: ${chunk.length}`);
      controller.enqueue(chunk);
    },
    flush() {
      const now = Date.now();
      console.log(`[speccing:stream] Stream finished for session ${sessionId} (+${now - streamStartTime}ms). Total chunks: ${chunkCount}, Total length: ${totalLength}`);
    }
  });

  if (!baseResponse.body) {
    throw new Error("Response body is empty or non-streamable");
  }

  return new Response(baseResponse.body.pipeThrough(loggingStream), {
    status: baseResponse.status,
    statusText: baseResponse.statusText,
    headers: baseResponse.headers,
  });
}

function constructDraftPrompt(workerUrl: string, subject: Moment, userPrompt: string): string {
  const citationUrl = subject.sourceMetadata?.simulation?.r2Key ? `${workerUrl}/audit/ingestion/file/${subject.sourceMetadata.simulation.r2Key}` : null;
  return `
# Role
You are the Machinen Speccing Actor (Technical Writer and Architect). Your role is to reassemble the historical development narrative provided by the Machinen Speccing Engine into an authoritative technical specification.

# Task: Initial Drafting
Your goal is to construct the FIRST draft of the technical specification based purely on the user's initial prompt and the high-level subject metadata. 

# Formatting Standard
- **Location**: Your output is a single markdown file.
- **Consensus Only**: Focus strictly on final consensus, settled decisions, and the "Definition of Done".
- **Source Citation**: Cite the subject moment. ${citationUrl ? `Citation URL: ${citationUrl}` : ""}
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

# User Prompt (THE SOURCE OF TRUTH FOR THIS DRAFT)
${userPrompt}

# Subject Metadata
Title: ${subject.title}
Summary: ${subject.summary}

# Action
Generate the FULL initial technical specification draft. Follow the Mandatory Spec Structure strictly. Use placeholders or "[To be refined]" for sections where details are currently unknown but likely to be revealed in the historical narrative (moments).
`;
}

function constructRevisePrompt(workerUrl: string, currentSpec: string, moment: Moment, evidence: any, userPrompt?: string): string {
  const citationUrl = evidence?.r2Key ? `${workerUrl}/audit/ingestion/file/${evidence.r2Key}` : null;
  return `
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

async function queueDescendants(
  context: MomentGraphContext,
  parentId: string,
  currentPq: string[]
): Promise<string[]> {
  const db = getMomentDb(context);
  const children = await db
    .selectFrom("moments")
    .select("id")
    .where("parent_id", "=", parentId)
    .execute();

  if (children.length > 0) {
    console.log(`[speccing:pq] Found ${children.length} descendants for ${parentId}. Appending to PQ.`);
    return [...currentPq, ...children.map((c) => c.id)];
  }
  console.log(`[speccing:pq] No descendants found for ${parentId}.`);
  return currentPq;
}

async function updateSessionProgress(
  db: ReturnType<typeof getSpeccingDb>,
  id: string,
  pq: string[],
  processed: string[]
) {
  await db
    .updateTable("speccing_sessions")
    .set({
      priority_queue_json: JSON.stringify(pq) as any,
      processed_ids_json: JSON.stringify(processed) as any,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", id)
    .execute();
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
      priority_queue_json: JSON.stringify(pq) as any,
      processed_ids_json: JSON.stringify(processed) as any,
      working_spec: spec,
      replay_timestamp: timestamp,
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", id)
    .execute();
}
