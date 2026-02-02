import { isDocumentChangedByEtag } from "../../../../engine/indexing/documentChangeIdentity";
import { PipelineContext } from "../../../../engine/runtime/types";
import { getIndexingState, updateIndexingState } from "../../../../engine/databases/indexingState";

export async function runIngestDiffForKey(input: {
  r2Key: string;
  context: PipelineContext;
}): Promise<{ etag: string; changed: boolean }> {
  const { r2Key, context } = input;

  // 1. Fetch Head from R2
  const head = await context.env.MACHINEN_BUCKET.head(r2Key);
  if (!head) {
    throw new Error(`R2 object not found: ${r2Key}`);
  }

  // 2. Load Previous ETag from Indexing State
  const state = await getIndexingState(r2Key, {
    env: context.env,
    momentGraphNamespace: context.momentGraphNamespace ?? null,
  });

  // 3. Compare
  const changed = isDocumentChangedByEtag({
    previousEtag: state?.etag ?? null,
    nextEtag: head.etag,
  });

  // 4. Persistence (Side Effect)
  if (changed) {
    await updateIndexingState(r2Key, head.etag, [], {
      env: context.env,
      momentGraphNamespace: context.momentGraphNamespace ?? null,
    });
  }

  return { etag: head.etag, changed };
}

