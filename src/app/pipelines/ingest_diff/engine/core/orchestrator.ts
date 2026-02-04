import { PipelineContext } from "../../../../engine/runtime/types";
import { updateIndexingState } from "../../../../engine/databases/indexingState";
import { 
  prepareDocumentForR2Key, 
  computeMomentGraphNamespaceForIndexing 
} from "../../../../engine/indexing/pluginPipeline";
import { createEngineContext } from "../../../../engine";

export async function runIngestDiffForKey(input: {
  r2Key: string;
  context: PipelineContext;
}): Promise<{ etag: string; changed: boolean; baseNamespace: string | null }> {
  const { r2Key, context } = input;

  // 1. Fetch Head from R2 (still needed to get the current etag)
  const head = await context.env.MACHINEN_BUCKET.head(r2Key);
  if (!head) {
    throw new Error(`R2 object not found: ${r2Key}`);
  }

  // 2. Resolve Base Namespace (Architecture Expansion)
  // We need to resolve the project-specific namespace for this document 
  // so that simulations can land in prefix:redwood:rwsdk instead of just the prefix.
  const { document, indexingContext } = await prepareDocumentForR2Key(
    r2Key,
    context.env,
    context.plugins
  );

  const baseNamespace = await computeMomentGraphNamespaceForIndexing(
    document,
    indexingContext,
    context.plugins
  );

  // 3. Always mark as changed
  const changed = true;

  // 4. Persistence (Update indexing state with current etag)
  await updateIndexingState(r2Key, head.etag, [], {
    env: context.env,
    momentGraphNamespace: context.momentGraphNamespace ?? null,
  });

  return { etag: head.etag, changed, baseNamespace };
}

