import { isDocumentChangedByEtag } from "../../../../engine/indexing/documentChangeIdentity";

export type IngestDiffOrchestratorPorts = {
  headR2Key: (r2Key: string) => Promise<{ etag: string }>;
  loadPreviousEtag: (r2Key: string) => Promise<string | null>;
  persistResult: (input: {
    r2Key: string;
    etag: string;
    changed: boolean;
  }) => Promise<void>;
  persistError: (input: { r2Key: string; error: string }) => Promise<void>;
};

export async function runIngestDiffForKey(input: {
  ports: IngestDiffOrchestratorPorts;
  r2Key: string;
}): Promise<{ etag: string; changed: boolean }> {
  try {
    const head = await input.ports.headR2Key(input.r2Key);
    const prevEtag = await input.ports.loadPreviousEtag(input.r2Key);
    const changed = isDocumentChangedByEtag({
      previousEtag: prevEtag,
      nextEtag: head.etag,
    });
    await input.ports.persistResult({
      r2Key: input.r2Key,
      etag: head.etag,
      changed,
    });
    return { etag: head.etag, changed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await input.ports.persistError({ r2Key: input.r2Key, error: msg });
    throw e;
  }
}

