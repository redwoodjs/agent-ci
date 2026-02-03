import { PipelineContext } from "../../../../engine/runtime/types";
import { updateIndexingState } from "../../../../engine/databases/indexingState";

export async function runIngestDiffForKey(input: {
  r2Key: string;
  context: PipelineContext;
}): Promise<{ etag: string; changed: boolean }> {
  const { r2Key, context } = input;

  // 1. Fetch Head from R2 (still needed to get the current etag)
  const head = await context.env.MACHINEN_BUCKET.head(r2Key);
  if (!head) {
    throw new Error(`R2 object not found: ${r2Key}`);
  }

  // 2. Always mark as changed
  const changed = true;

  // 3. Persistence (Update indexing state with current etag)
  await updateIndexingState(r2Key, head.etag, [], {
    env: context.env,
    momentGraphNamespace: context.momentGraphNamespace ?? null,
  });

  return { etag: head.etag, changed };
}

