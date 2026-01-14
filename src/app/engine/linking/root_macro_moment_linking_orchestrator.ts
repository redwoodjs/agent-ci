import { computePhaseEDeterministicLinkingDecision } from "./phaseE_deterministic_linking_orchestrator";
import { computePhaseFCandidateSet } from "./phaseF_candidate_sets_orchestrator";
import { computePhaseGTimelineFitDecision } from "./phaseG_timeline_fit_orchestrator";

export type RootLinkingPorts = {
  phaseE: Parameters<typeof computePhaseEDeterministicLinkingDecision>[0]["ports"];
  phaseF: Parameters<typeof computePhaseFCandidateSet>[0]["ports"];
  phaseG: Parameters<typeof computePhaseGTimelineFitDecision>[0]["ports"];
};

export async function computeRootMacroMomentParentSelection(input: {
  ports: RootLinkingPorts;
  env: Cloudflare.Env;
  r2Key: string;
  streamId: string;
  childMomentId: string;
  childDocumentId: string;
  childCreatedAt: string;
  childSourceMetadata?: Record<string, any>;
  childTitle: string | null;
  childSummary: string | null;
  macroAnchors?: string[] | null;
}): Promise<{
  parentId: string | null;
  auditLog: Record<string, any>;
}> {
  const childText = `${input.childTitle ?? ""}\n${input.childSummary ?? ""}`.trim();

  const phaseE = await computePhaseEDeterministicLinkingDecision({
    ports: input.ports.phaseE,
    r2Key: input.r2Key,
    streamId: input.streamId,
    macroIndex: 0,
    childMomentId: input.childMomentId,
    prevMomentId: null,
    childDocumentId: input.childDocumentId,
    childCreatedAt: input.childCreatedAt,
    childSourceMetadata: input.childSourceMetadata,
    macroAnchors: input.macroAnchors ?? null,
    childTextForFallbackAnchors: childText,
  });

  const auditLog: Record<string, any> = {
    kind: "live.linking",
    phaseE: phaseE.audit,
    phaseF: null,
    phaseG: null,
  };

  if (phaseE.proposedParentId) {
    return { parentId: phaseE.proposedParentId, auditLog };
  }

  if (!childText) {
    auditLog.phaseF = { candidates: [], stats: { reason: "empty-query" } };
    auditLog.phaseG = { chosenParentId: null, decisions: [], stats: { candidateCount: 0 } };
    return { parentId: null, auditLog };
  }

  const maxCandidatesRaw = (input.env as any).MOMENT_LINKING_CANDIDATE_SET_MAX;
  const maxCandidates =
    typeof maxCandidatesRaw === "string"
      ? Number.parseInt(maxCandidatesRaw, 10)
      : typeof maxCandidatesRaw === "number"
      ? maxCandidatesRaw
      : 10;

  const phaseF = await computePhaseFCandidateSet({
    ports: input.ports.phaseF,
    childMomentId: input.childMomentId,
    childDocumentId: input.childDocumentId,
    childCreatedAt: input.childCreatedAt,
    childSourceMetadata: input.childSourceMetadata,
    childText,
    maxCandidates: Number.isFinite(maxCandidates) ? maxCandidates : 10,
  });

  auditLog.phaseF = {
    candidates: phaseF.candidates,
    stats: phaseF.stats,
    debug: phaseF.debug,
  };

  const candidateIds = phaseF.candidates.map((c) => c.id);
  const rows = await input.ports.phaseF.loadCandidateRowsById(candidateIds);
  const deepCandidates = phaseF.candidates.map((c) => {
    const row = rows.get(c.id) ?? null;
    return {
      id: c.id,
      score: c.score,
      documentId: row?.document_id ?? null,
      title: row?.title ?? null,
      summary: row?.summary ?? null,
    };
  });

  const useLlmVetoRaw = (input.env as any).MOMENT_LINKING_TIMELINE_FIT_USE_LLM;
  const useLlmVeto =
    useLlmVetoRaw === true ||
    (typeof useLlmVetoRaw === "string" &&
      (useLlmVetoRaw.trim() === "1" ||
        useLlmVetoRaw.trim().toLowerCase() === "true"));

  const phaseG = await computePhaseGTimelineFitDecision({
    ports: input.ports.phaseG,
    childMomentId: input.childMomentId,
    childText,
    candidates: deepCandidates,
    useLlmVeto,
    maxAnchorTokens: 24,
    maxSharedAnchorTokens: 12,
  });

  auditLog.phaseG = phaseG;
  return { parentId: phaseG.chosenParentId, auditLog };
}

