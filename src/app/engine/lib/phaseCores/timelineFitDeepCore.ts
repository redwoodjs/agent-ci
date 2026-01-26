export type TimelineFitDecision = {
  candidateId: string;
  score: number | null;
  selected: boolean;
  rejected?: boolean;
  rejectReason?: string;
  rank?: number;
  details?: Record<string, any>;
};

export type TimelineFitDeepCandidate = {
  id: string;
  score: number | null;
  documentId: string | null;
  title: string | null;
  summary: string | null;
};

export async function computeTimelineFitProposalDeep(input: {
  childMomentId: string;
  childText: string;
  candidates: TimelineFitDeepCandidate[];
  extractAnchorTokens: (text: string, maxTokens: number) => string[];
  maxAnchorTokens: number;
  maxSharedAnchorTokens: number;
  useLlmVeto: boolean;
  llmVeto?: (input: {
    childText: string;
    candidates: Array<{ id: string; title: string | null; summary: string | null }>;
  }) => Promise<{ vetoedIds: string[]; note?: string | null }>;
}): Promise<{
  candidateCount: number;
  chosenParentId: string | null;
  decisions: TimelineFitDecision[];
  veto?: { vetoedIds: string[]; note?: string | null } | null;
}> {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const candidateCount = candidates.length;
  if (candidateCount === 0) {
    return { candidateCount, chosenParentId: null, decisions: [], veto: null };
  }

  const childTokens = input.extractAnchorTokens(
    input.childText,
    input.maxAnchorTokens
  );
  const childSet = new Set(childTokens);

  const ranked = candidates
    .map((c) => {
      const parentText = `${c.title ?? ""}\n${c.summary ?? ""}`.trim();
      const parentTokens = input.extractAnchorTokens(
        parentText,
        input.maxAnchorTokens
      );
      const shared: string[] = [];
      for (const t of parentTokens) {
        if (childSet.has(t)) {
          shared.push(t);
          if (shared.length >= input.maxSharedAnchorTokens) {
            break;
          }
        }
      }
      return { c, shared };
    })
    .sort((a, b) => {
      const aShared = a.shared.length;
      const bShared = b.shared.length;
      if (aShared !== bShared) {
        return bShared - aShared;
      }
      const aScore = typeof a.c.score === "number" ? a.c.score : -1;
      const bScore = typeof b.c.score === "number" ? b.c.score : -1;
      if (aScore !== bScore) {
        return bScore - aScore;
      }
      return a.c.id.localeCompare(b.c.id);
    });

  let veto: { vetoedIds: string[]; note?: string | null } | null = null;
  if (input.useLlmVeto && input.llmVeto) {
    veto = await input.llmVeto({
      childText: input.childText,
      candidates: ranked.slice(0, 5).map((r) => ({
        id: r.c.id,
        title: r.c.title ?? null,
        summary: r.c.summary ?? null,
      })),
    });
  }
  const vetoed = new Set<string>(
    Array.isArray(veto?.vetoedIds) ? veto!.vetoedIds : []
  );

  const decisions: TimelineFitDecision[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const entry = ranked[i]!;
    const id = entry.c.id;
    const isSelf = id === input.childMomentId;
    const isVetoed = vetoed.has(id);
    const hasSignal = entry.shared.length > 0;
    
    decisions.push({
      candidateId: id,
      score: typeof entry.c.score === "number" ? entry.c.score : null,
      selected: !isSelf && !isVetoed && hasSignal && i === 0,
      rejected: isSelf || isVetoed || !hasSignal,
      rejectReason: isSelf ? "self" : isVetoed ? "llm-veto" : !hasSignal ? "no-shared-anchors" : undefined,
      rank: i + 1,
      details: {
        sharedAnchorTokens: entry.shared,
      },
    });
  }

  const firstOk =
    ranked.find((r) => r.c.id !== input.childMomentId && !vetoed.has(r.c.id) && r.shared.length > 0) ??
    null;
  const chosenParentId = firstOk ? firstOk.c.id : null;

  return { candidateCount, chosenParentId, decisions, veto };
}

