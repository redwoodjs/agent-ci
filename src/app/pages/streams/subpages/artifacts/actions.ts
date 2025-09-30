"use server";

import { db } from "@/db";
import { env } from "cloudflare:workers";

export async function discoverNewArtifacts({ streamID }: { streamID: number }) {
  const stream = await db
    .selectFrom("streams")
    .select("subjects")
    .where("id", "=", streamID)
    .executeTakeFirstOrThrow();

  const result = await env.AI.autorag("machinen-context-stream").aiSearch({
    system_prompt:
      "You are a subject discovery agent. You are given a list of subjects and you need to discover artifacts that are related to the subjects.",
    query: stream.subjects,
    rewrite_query: true,
    filters: {
      type: "or",
      filters: [
        {
          key: "filename",
          type: "eq",
          value: "raw.json",
        },
        {
          key: "filename",
          type: "eq",
          value: "raw.md",
        },
      ],
    },
  });

  console.log(result.data);

  // we take the bucket; and return the subject and the raw.md file;
  // we store this in the database.
  const q = db.insertInto("stream_artifacts");
  for (const data of result.data) {
    const bucketPath = data.attributes.folder as string;
    const score = data.score as number;

    const artifact = await db
      .selectFrom("artifacts")
      .select("id")
      .where("bucketPath", "=", bucketPath)
      .executeTakeFirst();

    if (!artifact) {
      console.log(`Artifact not found for bucket path: ${bucketPath}`);
      continue;
    }

    await db
      .insertInto("stream_artifacts")
      .values({
        // @ts-ignore
        id: null,
        streamID,
        artifactID: artifact.id,
        score,
      })
      .execute();
  }
}
