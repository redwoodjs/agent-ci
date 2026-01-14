import type { Moment } from "../../types";

export type MaterializeMomentsOrchestratorPorts = {
  computeMomentId: (input: {
    effectiveNamespace: string | null;
    documentId: string;
    streamId: string;
    macroIndex: number;
  }) => Promise<string>;
  computeMicroPathsHash: (input: { microPaths: string[] | null }) => Promise<string | null>;
  upsertMoment: (input: { moment: Moment }) => Promise<void>;
  persistMaterializedMoment?: (input: {
    r2Key: string;
    streamId: string;
    macroIndex: number;
    momentId: string;
  }) => Promise<void>;
};

export async function materializeMomentsForDocument(input: {
  ports: MaterializeMomentsOrchestratorPorts;
  effectiveNamespace: string | null;
  runIdOrScope: string;
  r2Key: string;
  documentId: string;
  now: string;
  streams: Array<{
    streamId: string;
    macroMoments: any[];
  }>;
}): Promise<{ momentsUpserted: number }> {
  let momentsUpserted = 0;

  for (const stream of input.streams) {
    const streamId =
      typeof (stream as any)?.streamId === "string"
        ? ((stream as any).streamId as string)
        : "stream";
    const macroMoments = Array.isArray((stream as any)?.macroMoments)
      ? ((stream as any).macroMoments as any[])
      : [];

    for (let i = 0; i < macroMoments.length; i++) {
      const m = macroMoments[i] ?? {};
      const title =
        typeof m.title === "string" && m.title.trim().length > 0
          ? m.title.trim()
          : "(untitled)";
      const summary =
        typeof m.summary === "string" && m.summary.trim().length > 0
          ? m.summary.trim()
          : "(empty)";
      const createdAt =
        typeof m.createdAt === "string" && m.createdAt.trim().length > 0
          ? m.createdAt.trim()
          : input.now;
      const author =
        typeof m.author === "string" && m.author.trim().length > 0
          ? m.author.trim()
          : "machinen";
      const microPaths = Array.isArray(m.microPaths)
        ? m.microPaths.filter((p: any) => typeof p === "string")
        : null;

      const microPathsHash = await input.ports.computeMicroPathsHash({
        microPaths,
      });

      const momentId = await input.ports.computeMomentId({
        effectiveNamespace: input.effectiveNamespace,
        documentId: input.documentId,
        streamId,
        macroIndex: i,
      });

      const sourceMetadata =
        typeof m.sourceMetadata === "object" && m.sourceMetadata
          ? (m.sourceMetadata as any)
          : {
              simulation: {
                identityScope: input.runIdOrScope,
                r2Key: input.r2Key,
                streamId,
                macroIndex: i,
              },
            };

      const moment: Moment = {
        id: momentId,
        documentId: input.documentId,
        summary,
        title,
        parentId: undefined,
        microPaths: microPaths ?? undefined,
        microPathsHash: microPathsHash ?? undefined,
        importance:
          typeof m.importance === "number" && Number.isFinite(m.importance)
            ? (m.importance as any)
            : undefined,
        linkAuditLog: undefined,
        isSubject: m.isSubject === true ? true : undefined,
        subjectKind: typeof m.subjectKind === "string" ? (m.subjectKind as any) : undefined,
        subjectReason:
          typeof m.subjectReason === "string" ? (m.subjectReason as any) : undefined,
        subjectEvidence: Array.isArray(m.subjectEvidence)
          ? (m.subjectEvidence as any)
          : undefined,
        momentKind: typeof m.momentKind === "string" ? (m.momentKind as any) : undefined,
        momentEvidence: Array.isArray(m.momentEvidence)
          ? (m.momentEvidence as any)
          : undefined,
        createdAt,
        author,
        sourceMetadata,
      };

      await input.ports.upsertMoment({ moment });
      if (input.ports.persistMaterializedMoment) {
        await input.ports.persistMaterializedMoment({
          r2Key: input.r2Key,
          streamId,
          macroIndex: i,
          momentId,
        });
      }

      momentsUpserted++;
    }
  }

  return { momentsUpserted };
}

