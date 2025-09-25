import { defineApp } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { realtimeRoute } from "rwsdk/realtime/worker";
import { render, prefix, route, layout } from "rwsdk/router";

import { type Sandbox, proxyToSandbox } from "@cloudflare/sandbox";

import { Document } from "@/app/Document";

import { auth } from "@/app/pages/auth/auth";
import { requireAuth } from "./app/pages/auth/interruptors";
import { setCommonHeaders } from "./app/headers";
import { recordPageview } from "@/app/services/pageviews";
import { db } from "@/db";

import { authRoutes } from "./app/pages/auth/routes";

// TASKS
import { TaskLayout } from "./app/components/task-layout";
import { taskRoutes } from "./app/pages/task/routes";
// TASK SUBPAGES
import { chatRoutes } from "./app/pages/chat/routes";
import { transcriptRoutes } from "./app/pages/task/subpages/transcripts/routes";
import { logsRoutes } from "./app/pages/logs/routes";
import { projectRoutes } from "./app/pages/project/routes";
import { editorRoutes } from "./app/pages/editor/routes";
import { termRoutes } from "./app/pages/term/routes";
import { previewRoutes } from "./app/pages/preview/routes";

import { doExploreRoutes } from "./app/plugins/do-explore/routes";
import {
  assemblePRSegmentsFromObjects,
  type StructuredSeg,
  type RetrievalSeg,
  assembleMeetingSegmentsFromObjects,
  sanitizeMeetingMetadata,
} from "./lib/assemble";

import { sanitizeMetadata } from "./lib/assemble";

export type AppContext = {
  sandbox: DurableObjectStub<Sandbox<unknown>>;
  user: any;
};

const app = defineApp([
  setCommonHeaders(),
  realtimeRoute(() => env.REALTIME_DURABLE_OBJECT),
  async function authMiddleware({ ctx, request }) {
    try {
      const session = await auth.api.getSession({
        headers: request.headers,
      });
      if (session?.user) {
        ctx.user = session.user;
      }
    } catch (error) {
      console.error("Session error:", error);
    }
  },

  render(Document, [
    route("/", [
      requireAuth,
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "/projects" },
        }),
    ]),
    prefix("/auth", authRoutes),
    prefix("/dox", doExploreRoutes),
    prefix("/projects", projectRoutes),

    layout(TaskLayout, [
      prefix("/tasks/:containerId", [
        ...taskRoutes,
        prefix("/transcript", transcriptRoutes),
        prefix("/chat", chatRoutes),
        prefix("/logs", logsRoutes),
        prefix("/editor", editorRoutes),
        prefix("/term", termRoutes),
        prefix("/preview", previewRoutes),
      ]),
    ]),
  ]),

  route("/ingest/search", async ({ request }) => {
    // get string
    const q = "radix";
    const k = 5;
    const queryVec = await embedWithWorkersAI(env.AI!, q);
    // @ts-ignore
    const results = await env.VECTORIZE.query(queryVec, { topK: k });
    return new Response(JSON.stringify(results, null, 2), {
      headers: { "content-type": "application/json" },
    });
  }),

  route("/ingest/meetings", async ({ request }) => {
    // grab all the meetings.
    const meetings = await env.MACHINEN_BUCKET.list({
      prefix: "meetings/",
      delimiter: "/",
    });

    for (const meeting of meetings.delimitedPrefixes) {
      const [_, meetingId] = meeting.split("/");
      const structured = await env.MACHINEN_BUCKET.get(
        `meetings/${meetingId}/structured.json`
      );
      const retrieval = await env.MACHINEN_BUCKET.get(
        `meetings/${meetingId}/retrieval.json`
      );

      const structuredText = await structured?.text();
      const retrievalText = await retrieval?.text();

      if (!structuredText || !retrievalText) {
        console.log(`No structured or retrieval text for ${meeting}`);
        continue;
      }

      const structuredJson = JSON.parse(structuredText) as {
        segments: StructuredSeg[];
      };
      const retrievalJson = JSON.parse(retrievalText) as {
        segments: RetrievalSeg[];
      };

      const docs = await assembleMeetingSegmentsFromObjects({
        meetingId,
        structuredSegments: structuredJson.segments,
        retrievalSegments: retrievalJson.segments,
        // participants: ["Peter","Justin","Amy"],   // optional meeting-level context
        // time_start: "2025-09-21T12:34:00Z",
        // time_end: "2025-09-21T12:42:00Z"
      });

      for (const seg of docs) {
        const metadata = sanitizeMeetingMetadata(seg);
        // console.log(metadata);

        const values = await embedWithWorkersAI(env.AI, seg.retrieval_summary);
        const x = await env.VECTORIZE.upsert([
          { id: seg.id, values, metadata },
        ]);
        console.log(x);
      }
    }

    return new Response("1", {});

    // fetch the raw files from machinen bucket.
    // const { text } = await request.json();
    // return Response.json({ text });
  }),

  route("/ingest/pr/:prID", async ({ request }) => {
    const prID = "redwoodjs-sdk-pr-752";

    const segments = await env.MACHINEN_BUCKET.get(`prs/${prID}/segments.json`);
    const structured = await env.MACHINEN_BUCKET.get(
      `prs/${prID}/structured.json`
    );
    const retrieval = await env.MACHINEN_BUCKET.get(
      `prs/${prID}/retrieval.json`
    );

    // const segmentsText = await segments?.text();
    const structuredText = await structured?.text();
    const retrievalText = await retrieval?.text();

    if (!structuredText || !retrievalText) {
      return new Response("No segments or structured text found", {
        status: 404,
      });
    }

    // const segmentsJson = JSON.parse(segmentsText);
    const structuredJson = JSON.parse(structuredText) as {
      segments: StructuredSeg[];
    };
    const retrievalJson = JSON.parse(retrievalText) as {
      segments: RetrievalSeg[];
    };

    const docs = await assemblePRSegmentsFromObjects({
      retrievalSegments: retrievalJson.segments,
      structuredSegments: structuredJson.segments,
      repo: "redwoodjs/sdk",
      pr_number: 752,
      // state: "open",
      // merged_at: "2025-09-24",
      // labels: ["feature", "bug"],
    });

    for (const seg of docs) {
      const values = await embedWithWorkersAI(env.AI, seg.retrieval_summary);
      // const body = JSON.stringify({
      //   id: d.id,
      //   text: d.retrieval_summary, // <-- embedding text
      //   metadata: {
      //     ...d, // includes all structured fields in d.metadata
      //     text_for_embedding: undefined, // keep payload lean
      //   },
      // });

      const metadata = {
        source_type: seg.source_type,
        source_id: seg.source_id,
        segment_index: seg.segment_index,
        title: seg.title,
        summary: seg.metadata?.summary,
        entities: seg.metadata?.entities,
        files: seg.metadata?.files,
        commits: seg.metadata?.commits,
        decisions: seg.metadata?.decisions,
        tags: seg.metadata?.tags,
        review_state: seg.metadata?.review_state,
        state: seg.metadata?.state,
        time_start: seg.metadata?.time_start,
        time_end: seg.metadata?.time_end,
      };

      await env.VECTORIZE.upsert([{ id: seg.id, values, metadata }]);
    }

    return new Response(
      JSON.stringify({
        docs,
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // fetch the raw files from machinen bucket.
    // const { text } = await request.json();
    // return Response.json({ text });
  }),
]);

export async function embedWithWorkersAI(
  AI: Ai,
  text: string
): Promise<number[]> {
  // Model outputs 384-d vectors
  const model = "@cf/baai/bge-base-en-v1.5";
  const { data } = await AI.run(model as any, { text });
  return data[0];
}

export { Sandbox } from "@cloudflare/sandbox";
export { RealtimeDurableObject } from "rwsdk/realtime/durableObject";
export { Database } from "@/db/durableObject";

export default {
  fetch: async function (request, env: Env, cf) {
    // TODO(peterp, 2025-09-18): This is a hack to get the chat working.
    // Get the proper ports from the database.

    const ports = ["4096", "8910", "5173"];

    // for (const port of ports) {
    //   if (request.url.includes(port)) {
    //     return proxyToSandbox(request, env);
    //   }
    // }

    const url = new URL(request.url);
    const port = url.hostname.split("-")[0];
    if (ports.includes(port)) {
      // we only record visits to the users tools.

      // Record that the user visited this sandbox.
      // try {
      //   const containerId = url.hostname
      //     .replace("5173-", "")
      //     .replace(".localhost", "");

      //   // Get laneId from database asynchronously (don't await to avoid blocking the request)
      //   const { laneId } = await db
      //     .selectFrom("tasks")
      //     .select("laneId")
      //     .where("containerId", "=", containerId)
      //     .executeTakeFirstOrThrow();

      //   recordPageview(request, containerId, laneId);
      // } catch (error) {
      //   console.error("Error in visit recording setup:", error);
      // }

      return proxyToSandbox(request, env);
    }

    return await app.fetch(request, env, cf);
  },
} as ExportedHandler;
