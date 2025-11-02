"use server";

import { env } from "cloudflare:workers";

export async function clearBucketFiles(prefix: string, sourceID: number) {
  let cursor: string | undefined = undefined;
  let deletedCount = 0;

  do {
    const listed = await env.MACHINEN_BUCKET.list({
      prefix,
      cursor,
    });

    const deletePromises = listed.objects.map((object) =>
      env.MACHINEN_BUCKET.delete(object.key)
    );

    await Promise.all(deletePromises);
    deletedCount += listed.objects.length;

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
