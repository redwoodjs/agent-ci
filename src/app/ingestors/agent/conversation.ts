import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { enqueueUnprocessedFiles } from "@/app/engine/services/scanner-service";

interface AgentConversationPayload {
  r2Key: string;
  content: string;
  metadata: {
    title: string;
    author: string;
    source: "antigravity";
    type: "artifact" | "conversation";
    repo: string;
    folder: string;
    branch: string;
  };
}

export async function agentConversationHandler({ request }: RequestInfo) {
  const payload = (await request.json()) as AgentConversationPayload;
  const { r2Key, content, metadata } = payload;

  if (!r2Key || !content) {
    return Response.json(
      { error: "Missing r2Key or content" },
      { status: 400 }
    );
  }

  console.log(`[agent ingest] Storing agent content to R2: ${r2Key}`, {
    type: metadata.type,
    repo: metadata.repo,
    branch: metadata.branch,
  });

  try {
    // 1. Save content to R2
    await env.MACHINEN_BUCKET.put(r2Key, content, {
      customMetadata: {
        title: metadata.title,
        author: metadata.author,
        source: metadata.source,
        type: metadata.type,
        repo: metadata.repo,
        folder: metadata.folder,
        branch: metadata.branch,
      },
    });

    // 2. Enqueue for indexing
    await enqueueUnprocessedFiles([r2Key], env);

    console.log(`[agent ingest] Successfully stored and enqueued: ${r2Key}`);

    return Response.json({ success: true, r2Key });
  } catch (error) {
    console.error(`[agent ingest] Error processing upload for ${r2Key}:`, error);
    return Response.json(
      {
        error: "Failed to process agent content",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
