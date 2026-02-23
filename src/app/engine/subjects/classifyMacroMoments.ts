import type { MacroMomentDescription, MomentKind, SubjectKind } from "../types";
import { callLLM } from "../utils/llm";
import type { PipelineContext } from "../runtime/types";

export type MacroMomentClassification = {
  index: number;
  momentKind: MomentKind;
  isSubject: boolean;
  subjectKind: SubjectKind | null;
  subjectReason: string | null;
  subjectEvidence: string[];
  momentEvidence: string[];
  confidence: "high" | "medium" | "low";
};

function safeArrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function safeMomentKind(value: unknown): MomentKind | null {
  if (typeof value !== "string") {
    return null;
  }
  const v = value.trim().toLowerCase();
  if (
    v === "problem" ||
    v === "challenge" ||
    v === "opportunity" ||
    v === "initiative" ||
    v === "attempt" ||
    v === "decision" ||
    v === "solution"
  ) {
    return v;
  }
  return null;
}

function safeSubjectKind(value: unknown): SubjectKind | null {
  if (typeof value !== "string") {
    return null;
  }
  const v = value.trim().toLowerCase();
  if (
    v === "problem" ||
    v === "challenge" ||
    v === "opportunity" ||
    v === "initiative"
  ) {
    return v;
  }
  return null;
}

function safeConfidence(value: unknown): "high" | "medium" | "low" {
  if (typeof value !== "string") {
    return "low";
  }
  const v = value.trim().toLowerCase();
  if (v === "high" || v === "medium" || v === "low") {
    return v;
  }
  return "low";
}

export async function classifyMacroMoments(input: {
  documentId: string;
  macroMoments: MacroMomentDescription[];
  pipelineContext?: PipelineContext;
}): Promise<MacroMomentClassification[] | null> {
  if (input.macroMoments.length === 0) {
    return [];
  }

  const momentsText = input.macroMoments
    .map((m, idx) => {
      const title = typeof m.title === "string" ? m.title : "";
      const summary = typeof m.summary === "string" ? m.summary : "";
      return `Index: ${idx + 1}\nTitle: ${title}\nSummary: ${summary}\n`;
    })
    .join("\n---\n\n");

  const prompt = `You are classifying macro moments in a timeline.

For each macro moment, output:
- momentKind: one of "problem", "challenge", "opportunity", "initiative", "attempt", "decision", "solution"
- isSubject: true only when momentKind is one of the topic demarcation kinds (problem/challenge/opportunity/initiative)
- subjectKind: when isSubject is true, this must be the same as momentKind
- subjectReason: when isSubject is true, 1-2 sentences explaining why this starts a topic
- subjectEvidence: when isSubject is true, a list of 1-4 exact substrings taken from the Title or Summary
- momentEvidence: a list of 1-4 exact substrings taken from the Title or Summary that support momentKind
- confidence: "high" | "medium" | "low". Use "low" when the kind is mostly inferred and not supported by explicit anchors.

Source rules:
- Cursor-style content is usually attempts and decisions, not solutions.
- Treat a merged pull request as a solution. If a pull request appears closed without merging, treat it as an attempt or decision, not a solution.

Output format:
- Return a single JSON array.
- Each item must have: index (1-based), momentKind, isSubject, subjectKind, subjectReason, subjectEvidence, momentEvidence, confidence.
- Do not include any extra text.

Document: ${input.documentId}

Macro moments:
${momentsText}
`;

  const raw = await callLLM(prompt, "cerebras-gpt-oss-120b", {
    temperature: 0,
    reasoning: { effort: "low" },
    pipelineContext: input.pipelineContext,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const out: MacroMomentClassification[] = [];
  for (const item of parsed) {
    const indexRaw = (item as any)?.index;
    const index =
      typeof indexRaw === "number" && Number.isFinite(indexRaw)
        ? Math.floor(indexRaw)
        : typeof indexRaw === "string"
          ? Number.parseInt(indexRaw, 10)
          : NaN;
    if (
      !Number.isFinite(index) ||
      index < 1 ||
      index > input.macroMoments.length
    ) {
      continue;
    }

    const momentKind = safeMomentKind((item as any)?.momentKind);
    if (!momentKind) {
      continue;
    }

    const isSubject = Boolean((item as any)?.isSubject);
    const subjectKind = safeSubjectKind((item as any)?.subjectKind);
    const subjectReasonRaw = (item as any)?.subjectReason;
    const subjectReason =
      typeof subjectReasonRaw === "string" && subjectReasonRaw.trim().length > 0
        ? subjectReasonRaw.trim()
        : null;

    const subjectEvidence = safeArrayOfStrings((item as any)?.subjectEvidence);
    const momentEvidence = safeArrayOfStrings((item as any)?.momentEvidence);
    const confidence = safeConfidence((item as any)?.confidence);

    out.push({
      index,
      momentKind,
      isSubject,
      subjectKind: isSubject ? (subjectKind ?? (momentKind as any)) : null,
      subjectReason: isSubject ? subjectReason : null,
      subjectEvidence: isSubject ? subjectEvidence : [],
      momentEvidence,
      confidence,
    });
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}
