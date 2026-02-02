import type { Moment, Document, MacroMomentDescription } from "../../../../engine/types";
import { PipelineContext } from "../../../../engine/runtime/types";
import { 
  computeMaterializedMomentIdentity, 
  computeMicroPathsHash 
} from "../../../../engine/lib/phaseCores/materializeMomentsCore";

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function uuidFromSha256Hex(hashHex: string): string {
  const hex = (hashHex ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  const padded = (hex + "0".repeat(64)).slice(0, 64);
  const bytes = padded.slice(0, 32);
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-${bytes.slice(
    12,
    16
  )}-${bytes.slice(16, 20)}-${bytes.slice(20, 32)}`;
}

export async function materializeMomentsForDocument(input: {
  document: Document;
  context: PipelineContext;
  runId: string;
  r2Key: string;
  now: string;
  streams: Array<{ streamId: string; macroMoments: MacroMomentDescription[] }>;
}): Promise<{ moments: Moment[] }> {
  const { document, context, runId, r2Key, now, streams } = input;
  const moments: Moment[] = [];

  for (const stream of streams) {
    const streamId = stream.streamId || "stream";
    const macroMoments = stream.macroMoments || [];

    for (let i = 0; i < macroMoments.length; i++) {
      const m = macroMoments[i]!;
      
      const microPaths = Array.isArray(m.microPaths) ? m.microPaths : null;
      const microPathsHash = await computeMicroPathsHash({ 
        microPaths, 
        sha256Hex 
      });

      const { momentId } = await computeMaterializedMomentIdentity({
        runId,
        effectiveNamespace: context.momentGraphNamespace ?? null,
        documentId: document.id,
        streamId,
        macroIndex: i,
        sha256Hex,
        uuidFromSha256Hex,
      });

      const moment: Moment = {
        id: momentId,
        documentId: document.id,
        summary: m.summary || "(empty)",
        title: m.title || "(untitled)",
        parentId: undefined,
        microPaths: microPaths ?? undefined,
        microPathsHash: microPathsHash ?? undefined,
        importance: m.importance,
        linkAuditLog: undefined,
        isSubject: m.isSubject,
        subjectKind: m.subjectKind,
        subjectReason: m.subjectReason,
        subjectEvidence: m.subjectEvidence,
        momentKind: m.momentKind,
        momentEvidence: m.momentEvidence,
        createdAt: m.createdAt || now,
        author: m.author || "machinen",
        sourceMetadata: m.sourceMetadata || {
          simulation: {
            identityScope: runId,
            r2Key: r2Key,
            streamId,
            macroIndex: i,
          },
        },
      };

      moments.push(moment);
    }
  }

  return { moments };
}
