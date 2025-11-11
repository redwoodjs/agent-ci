import { env } from "cloudflare:workers";
import { getIndexingState } from "../db";
import type { Cloudflare } from "wrangler";

export async function scanForUnprocessedFiles(
  env: Cloudflare.Env,
  prefix: string = "github/"
): Promise<string[]> {
  const unprocessedKeys: string[] = [];
  let cursor: string | undefined = undefined;

  console.log(`[scanner] Starting scan for prefix: ${prefix}`);

  do {
    const listed = await env.MACHINEN_BUCKET.list({
      prefix,
      cursor,
    });

    for (const object of listed.objects) {
      if (!object.key.endsWith("latest.json")) {
        continue;
      }

      const state = await getIndexingState(object.key);

      if (!state) {
        unprocessedKeys.push(object.key);
        console.log(
          `[scanner] Found unprocessed file (no state): ${object.key} (etag: ${object.etag})`
        );
      } else if (state.etag !== object.etag) {
        unprocessedKeys.push(object.key);
        console.log(
          `[scanner] Found updated file: ${object.key} (stored etag: ${state.etag}, current etag: ${object.etag})`
        );
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  console.log(
    `[scanner] Scan complete. Found ${unprocessedKeys.length} unprocessed files.`
  );

  return unprocessedKeys;
}

export async function enqueueUnprocessedFiles(
  unprocessedKeys: string[],
  env: Cloudflare.Env
): Promise<void> {
  if (!env.ENGINE_INDEXING_QUEUE) {
    throw new Error("ENGINE_INDEXING_QUEUE binding not found");
  }

  const batchSize = 10;
  for (let i = 0; i < unprocessedKeys.length; i += batchSize) {
    const batch = unprocessedKeys.slice(i, i + batchSize);
    await env.ENGINE_INDEXING_QUEUE.sendBatch(
      batch.map((r2Key) => ({
        body: { r2Key },
      }))
    );
    console.log(
      `[scanner] Enqueued batch of ${batch.length} files (${i + 1}-${Math.min(i + batchSize, unprocessedKeys.length)} of ${unprocessedKeys.length})`
    );
  }
}

export async function processScannerJob(env: Cloudflare.Env): Promise<void> {
  console.log("[scanner] Starting scanner job");

  const unprocessedKeys = await scanForUnprocessedFiles(env, "github/");

  if (unprocessedKeys.length > 0) {
    await enqueueUnprocessedFiles(unprocessedKeys, env);
    console.log(
      `[scanner] Scanner job complete. Enqueued ${unprocessedKeys.length} files for indexing.`
    );
  } else {
    console.log("[scanner] Scanner job complete. No unprocessed files found.");
  }
}

