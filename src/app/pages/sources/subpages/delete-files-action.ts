"use server";

import { env } from "cloudflare:workers";

export async function deleteSelectedFiles(keys: string[]) {
  const deletePromises: Promise<void>[] = [];

  for (const key of keys) {
    const listed = await env.MACHINEN_BUCKET.list({
      prefix: key,
    });

    for (const object of listed.objects) {
      deletePromises.push(env.MACHINEN_BUCKET.delete(object.key));
    }
  }

  await Promise.all(deletePromises);
  return { success: true, deletedCount: deletePromises.length };
}
