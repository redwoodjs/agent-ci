"use server";

import { env } from "cloudflare:workers";
import { db } from "@/db";
import { rawDiscordDb } from "@/app/ingestors/discord/db";

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

  const source = await db
    .selectFrom("sources")
    .selectAll()
    .where("id", "=", sourceID)
    .executeTakeFirst();

  if (source?.type === "discord") {
    try {
      const channelID = "1307974274145062912";

      if (channelID) {
        await rawDiscordDb
          .updateTable("raw_discord_messages")
          .set({ processed_state: "unprocessed" })
          .where("channel_id", "=", channelID)
          .execute();
      }
    } catch (e) {
      console.error("Error clearing bucket files for Discord source", sourceID);
      console.error(e);
      // ignore
    }
  }
}
