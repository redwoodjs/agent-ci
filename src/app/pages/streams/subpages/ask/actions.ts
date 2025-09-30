"use server";

import { env } from "cloudflare:workers";
import { db } from "@/db";

export async function ask({
  streamID,
  prompt,
}: {
  streamID: number;
  prompt: string;
}) {
  // grab all artifacts associated to this stream.
  const artifacts = await db
    .selectFrom("stream_artifacts")
    .innerJoin("artifacts", "artifacts.id", "stream_artifacts.artifactID")
    .select("artifacts.bucketPath")
    .where("streamID", "=", streamID)
    .execute();

  const filters: ComparisonFilter[] = artifacts.map((artifact) => ({
    key: "folder",
    type: "eq",
    value: artifact.bucketPath,
  }));

  console.log(filters);
  console.log(prompt);

  const result = await env.AI.autorag("machinen-context-stream").aiSearch({
    system_prompt:
      "You are a helpful assistant that can answer questions about the artifacts in the stream.",
    query: prompt,
    max_num_results: 5,
    rewrite_query: true,
    filters: {
      type: "or",
      filters: filters,
    },
  });

  return result.response;
}
