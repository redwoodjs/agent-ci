import { getIndexingStatesBatch } from "../databases/indexingState";
import { isDocumentChangedByEtag } from "../indexing/documentChangeIdentity";

export async function scanForUnprocessedFiles(
  env: Cloudflare.Env,
  prefix: string = "github/",
  options?: {
    ignoreIndexingState?: boolean;
    momentGraphNamespace?: string | null;
  }
): Promise<string[]> {
  const unprocessedKeys: string[] = [];
  let cursor: string | undefined = undefined;
  let totalFiles = 0;
  let dbQueries = 0;
  const logInterval = 100;
  const batchSize = 100;

  const ignoreIndexingState = Boolean(options?.ignoreIndexingState);
  const momentGraphNamespace =
    typeof options?.momentGraphNamespace === "string" &&
    options.momentGraphNamespace.trim().length > 0
      ? options.momentGraphNamespace.trim()
      : null;

  console.log(`[scanner] Starting scan for prefix: ${prefix}`, {
    ignoreIndexingState,
    momentGraphNamespace,
  });

  do {
    const listed = await env.MACHINEN_BUCKET.list({
      prefix,
      cursor,
    });

    const batchKeys: string[] = [];
    const batchObjects: Array<{ key: string; etag: string }> = [];

    for (const object of listed.objects) {
      // Include both latest.json files and Discord .jsonl files
      // Exclude old Discord thread files with pattern: YYYY-MM-DD-thread-ID.jsonl
      const isIndexableFile =
        object.key.endsWith("latest.json") ||
        (object.key.startsWith("discord/") &&
          object.key.endsWith(".jsonl") &&
          !object.key.includes("-thread-"));

      if (!isIndexableFile) {
        continue;
      }

      totalFiles++;
      batchKeys.push(object.key);
      batchObjects.push({ key: object.key, etag: object.etag });

      if (batchKeys.length >= batchSize) {
        dbQueries++;
        try {
          if (ignoreIndexingState) {
            for (const { key } of batchObjects) {
              unprocessedKeys.push(key);
            }
          } else {
            const states = await getIndexingStatesBatch(batchKeys, {
              env,
              momentGraphNamespace,
            });

            for (const { key, etag } of batchObjects) {
              const state = states.get(key);
              if (
                isDocumentChangedByEtag({
                  previousEtag: state?.etag ?? null,
                  nextEtag: etag ?? null,
                })
              ) {
                unprocessedKeys.push(key);
              }
            }
          }
        } catch (error) {
          console.error(
            `[scanner] Error fetching batch states: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          throw error;
        }

        batchKeys.length = 0;
        batchObjects.length = 0;

        if (totalFiles % logInterval === 0) {
          console.log(
            `[scanner] Progress: scanned ${totalFiles} files, ${dbQueries} DB queries, ${unprocessedKeys.length} unprocessed so far`
          );
        }
      }
    }

    if (batchKeys.length > 0) {
      dbQueries++;
      try {
        if (ignoreIndexingState) {
          for (const { key } of batchObjects) {
            unprocessedKeys.push(key);
          }
        } else {
          const states = await getIndexingStatesBatch(batchKeys, {
            env,
            momentGraphNamespace,
          });

          for (const { key, etag } of batchObjects) {
            const state = states.get(key);
            if (
              isDocumentChangedByEtag({
                previousEtag: state?.etag ?? null,
                nextEtag: etag ?? null,
              })
            ) {
              unprocessedKeys.push(key);
            }
          }
        }
      } catch (error) {
        console.error(
          `[scanner] Error fetching final batch states: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        throw error;
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  console.log(
    `[scanner] Scan complete. Scanned ${totalFiles} files, made ${dbQueries} DB queries, found ${unprocessedKeys.length} unprocessed files.`
  );

  return unprocessedKeys;
}

export async function enqueueUnprocessedFiles(
  unprocessedKeys: string[],
  env: Cloudflare.Env,
  options?: {
    momentGraphNamespace?: string | null;
    momentGraphNamespacePrefix?: string | null;
  }
): Promise<void> {
  if (!env.ENGINE_INDEXING_QUEUE) {
    throw new Error("ENGINE_INDEXING_QUEUE binding not found");
  }

  const momentGraphNamespace =
    typeof options?.momentGraphNamespace === "string" &&
    options.momentGraphNamespace.trim().length > 0
      ? options.momentGraphNamespace.trim()
      : null;

  const momentGraphNamespacePrefix =
    typeof options?.momentGraphNamespacePrefix === "string" &&
    options.momentGraphNamespacePrefix.trim().length > 0
      ? options.momentGraphNamespacePrefix.trim()
      : null;

  const batchSize = 10;
  for (let i = 0; i < unprocessedKeys.length; i += batchSize) {
    const batch = unprocessedKeys.slice(i, i + batchSize);
    await env.ENGINE_INDEXING_QUEUE.sendBatch(
      batch.map((r2Key) => ({
        body: {
          r2Key,
          ...(momentGraphNamespace ? { momentGraphNamespace } : {}),
          ...(momentGraphNamespacePrefix ? { momentGraphNamespacePrefix } : {}),
        },
      }))
    );
    console.log(
      `[scanner] Enqueued batch of ${batch.length} files (${i + 1}-${Math.min(
        i + batchSize,
        unprocessedKeys.length
      )} of ${unprocessedKeys.length})`
    );
  }
}

export async function processScannerJob(
  env: Cloudflare.Env,
  prefix?: string
): Promise<void> {
  console.log("[scanner] Starting scanner job");

  // If no prefix specified, scan all sources
  const prefixes = prefix ? [prefix] : ["github/", "discord/", "cursor/"];

  let totalUnprocessedKeys: string[] = [];

  for (const scanPrefix of prefixes) {
    console.log(`[scanner] Scanning prefix: ${scanPrefix}`);
    const unprocessedKeys = await scanForUnprocessedFiles(env, scanPrefix);
    totalUnprocessedKeys = totalUnprocessedKeys.concat(unprocessedKeys);
  }

  if (totalUnprocessedKeys.length > 0) {
    await enqueueUnprocessedFiles(totalUnprocessedKeys, env);
    console.log(
      `[scanner] Scanner job complete. Enqueued ${totalUnprocessedKeys.length} files for indexing.`
    );
  } else {
    console.log("[scanner] Scanner job complete. No unprocessed files found.");
  }
}
