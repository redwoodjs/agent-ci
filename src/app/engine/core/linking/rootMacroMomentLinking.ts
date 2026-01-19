import { computeDeterministicLinkingDecision } from "./deterministicLinkingOrchestrator";
import { computeCandidateSet } from "./candidateSetsOrchestrator";
import { computeTimelineFitDecision } from "./timelineFitOrchestrator";

export type RootMacroMomentLinkingPorts = {
  deterministicLinking: Parameters<typeof computeDeterministicLinkingDecision>[0]["ports"];
  candidateSets: Parameters<typeof computeCandidateSet>[0]["ports"];
  timelineFit: Parameters<typeof computeTimelineFitDecision>[0]["ports"];
};

export async function computeRootMacroMomentParentSelection(input: {
  ports: RootMacroMomentLinkingPorts;
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

  const deterministic = await computeDeterministicLinkingDecision({
    ports: input.ports.deterministicLinking,
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
    deterministic_linking: deterministic.audit,
    candidate_sets: null,
    timeline_fit: null,
  };

  if (deterministic.proposedParentId) {
    return { parentId: deterministic.proposedParentId, auditLog };
  }

  if (!childText) {
    auditLog.candidate_sets = { candidates: [], stats: { reason: "empty-query" } };
    auditLog.timeline_fit = {
      chosenParentId: null,
      decisions: [],
      stats: { candidateCount: 0 },
    };
    return { parentId: null, auditLog };
  }

  const maxCandidatesRaw = (input.env as any).MOMENT_LINKING_CANDIDATE_SET_MAX;
  const maxCandidates =
    typeof maxCandidatesRaw === "string"
      ? Number.parseInt(maxCandidatesRaw, 10)
      : typeof maxCandidatesRaw === "number"
      ? maxCandidatesRaw
      : 10;

  const candidateSet = await computeCandidateSet({
    ports: input.ports.candidateSets,
    childMomentId: input.childMomentId,
    childDocumentId: input.childDocumentId,
    childCreatedAt: input.childCreatedAt,
    childSourceMetadata: input.childSourceMetadata,
    childText,
    maxCandidates: Number.isFinite(maxCandidates) ? maxCandidates : 10,
  });

  auditLog.candidate_sets = {
    candidates: candidateSet.candidates,
    stats: candidateSet.stats,
    debug: candidateSet.debug,
  };

  const candidateIds = candidateSet.candidates.map((c) => c.id);
  const rows = await input.ports.candidateSets.loadCandidateRowsById(candidateIds);
  const deepCandidates = candidateSet.candidates.map((c) => {
    const row = rows.get(c.id) ?? null;
    return {
      id: c.id,
      score: c.score,
      documentId: row?.document_id ?? null,
      title: row?.title ?? null,
      summary: row?.summary ?? null,
    };
  });

  const useLlmVeto = true;

  const timelineFit = await computeTimelineFitDecision({
    ports: input.ports.timelineFit,
    childMomentId: input.childMomentId,
    childText,
    candidates: deepCandidates,
    useLlmVeto,
    maxAnchorTokens: 24,
    maxSharedAnchorTokens: 12,
  });

  auditLog.timeline_fit = timelineFit;
  return { parentId: timelineFit.chosenParentId, auditLog };
}

