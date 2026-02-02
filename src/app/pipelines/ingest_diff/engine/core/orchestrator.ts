import { isDocumentChangedByEtag } from "../../../../engine/indexing/documentChangeIdentity";
import { PipelineContext } from "../../../../engine/runtime/types";

export type IngestDiffOutput = {
  etag: string;
  changed: boolean;
};

export async function runIngestDiffForKey(input: {
  context: PipelineContext;
  r2Key: string;
  previousEtag: string | null;
}): Promise<IngestDiffOutput> {
  const head = await input.context.env.MACHINEN_BUCKET.head(input.r2Key);
  const etag = head?.etag ?? ""; // Use empty string if no etag, though usually exists
  
  if (!head) {
      // If object doesn't exist, technically it's not changed, it's deleted?
      // For ingest_diff, we usually assume the object exists if we are processing it.
      // Or we can throw.
      throw new Error(`Object not found in R2: ${input.r2Key}`);
  }

  const changed = isDocumentChangedByEtag({
    previousEtag: input.previousEtag,
    nextEtag: etag,
  });

  return { etag, changed };
}

