"use server";

import { env } from "cloudflare:workers";
import { db } from "@/db";

export async function rewriteQueryWithMemory(query: string) {
  const result = await env.AI.autorag("machinen-context-stream").aiSearch({
    system_prompt:
      "You are a query rewriter. Match the query to the content available, then rewrite the query to better match the content. Only return the rewritten query.",
    query,

    rewrite_query: true,
    ranking_options: {
      score_threshold: 0.6,
    },

    filters: {
      key: "filename",
      type: "eq",
      value: "subject.json",
    },
  });
  return result.response;
}

export async function saveQuery({
  streamID,
  query,
}: {
  streamID: number;
  query: string;
}) {
  await db
    .updateTable("streams")
    .set({
      subjects: query,
    })
    .where("id", "=", streamID)
    .execute();
}
