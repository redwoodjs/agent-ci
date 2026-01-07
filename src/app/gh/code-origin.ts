import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import {
  findAncestors,
  findLastMomentForDocument,
  findDescendants,
  type MomentGraphContext,
} from "@/app/engine/momentDb";
import { getPullRequestsForCommit } from "./github-utils";
import { callLLM } from "@/app/engine/utils/llm";
import { getMomentGraphNamespaceFromEnv } from "@/app/engine/momentGraphNamespace";

function formatIso8601(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return trimmed;
  }
  return date.toISOString();
}

function readTimeMs(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const date = new Date(trimmed);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function timelineSortKey(moment: {
  createdAt?: string;
  sourceMetadata?: Record<string, any>;
}): number | null {
  const timeRange = (moment.sourceMetadata as any)?.timeRange as
    | { start?: unknown; end?: unknown }
    | undefined;
  const startMs = readTimeMs(timeRange?.start);
  if (startMs !== null) {
    return startMs;
  }
  return readTimeMs(moment.createdAt);
}

function formatTimelineLine(
  moment: {
    createdAt?: string;
    title?: string;
    summary?: string;
    sourceMetadata?: Record<string, any>;
    importance?: number;
  },
  idx: number
): string {
  const timeRange = (moment.sourceMetadata as any)?.timeRange as
    | { start?: unknown; end?: unknown }
    | undefined;
  const rangeStart = formatIso8601(timeRange?.start);
  const rangeEnd = formatIso8601(timeRange?.end);
  const iso = formatIso8601(moment.createdAt);
  const prefix =
    rangeStart.length > 0 && rangeEnd.length > 0 && rangeStart !== rangeEnd
      ? `${rangeStart}..${rangeEnd} `
      : iso.length > 0
      ? `${iso} `
      : "";

  const rawImportance = moment.importance;
  const importance =
    typeof rawImportance === "number" && Number.isFinite(rawImportance)
      ? Math.max(0, Math.min(1, rawImportance))
      : null;
  const importanceText =
    importance === null
      ? `importance=not_provided `
      : `importance=${importance.toFixed(2)} `;

  return `${prefix}${importanceText}${idx + 1}. ${moment.title}: ${
    moment.summary
  }`;
}

export async function codeOriginHandler({ request, ctx }: RequestInfo) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    let body: {
      file?: unknown;
      line?: unknown;
      commitHash?: unknown;
      owner?: unknown;
      repo?: unknown;
      namespace?: unknown;
    } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }

    const file = typeof body.file === "string" ? body.file : null;
    const line = typeof body.line === "number" ? body.line : null;
    const commitHash =
      typeof body.commitHash === "string" ? body.commitHash : null;
    const owner = typeof body.owner === "string" ? body.owner : null;
    const repo = typeof body.repo === "string" ? body.repo : null;
    const namespaceOverride =
      typeof body.namespace === "string" ? body.namespace : null;

    if (!file || line === null || !commitHash || !owner || !repo) {
      return new Response(
        "Missing required parameters: file, line, commitHash, owner, repo",
        {
          status: 400,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }
      );
    }

    const envCloudflare = env as Cloudflare.Env;

    // 1. Get PR number from GitHub API
    console.log(
      `[code-origin] Fetching PR for commit ${commitHash} in ${owner}/${repo}`
    );
    const prNumbers = await getPullRequestsForCommit(
      owner,
      repo,
      commitHash,
      envCloudflare
    );

    const prNumber = prNumbers.length > 0 ? prNumbers[0] : null;

    if (!prNumber) {
      return new Response(`No pull request found for commit ${commitHash}`, {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    console.log(`[code-origin] Found PR #${prNumber} for commit ${commitHash}`);

    // 2. Map PR to R2 key
    const r2Key = `github/${owner}/${repo}/pull-requests/${prNumber}/latest.json`;

    // 3. Fetch PR data from R2
    const bucket = envCloudflare.MACHINEN_BUCKET;
    const prObject = await bucket.get(r2Key);
    if (!prObject) {
      return new Response(`PR data not found in R2: ${r2Key}`, {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    const prData = (await prObject.json()) as any;
    console.log(`[code-origin] Fetched PR data from R2: ${r2Key}`);

    // 4. Find Moment in Graph
    const momentGraphNamespace =
      namespaceOverride ?? getMomentGraphNamespaceFromEnv(envCloudflare);
    const momentGraphContext: MomentGraphContext = {
      env: envCloudflare,
      momentGraphNamespace: momentGraphNamespace,
    };

    const lastMoment = await findLastMomentForDocument(
      r2Key,
      momentGraphContext
    );

    if (!lastMoment) {
      return new Response(
        `No indexed moments found for PR #${prNumber}. The PR may not have been indexed yet.`,
        {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }
      );
    }

    console.log(
      `[code-origin] Found moment ${lastMoment.id} for document ${r2Key}`
    );

    // 5. Extract Decisions & Timeline
    const ancestors = await findAncestors(lastMoment.id, momentGraphContext);
    const root = ancestors[0] ?? lastMoment;
    const descendants = await findDescendants(root.id, momentGraphContext);

    console.log(
      `[code-origin] Found ${ancestors.length} ancestors and ${descendants.length} descendants`
    );

    // 6. Build timeline
    const allMoments = [...ancestors, ...descendants];
    const sortedTimeline = [...allMoments].sort((a, b) => {
      const aKey = timelineSortKey(a);
      const bKey = timelineSortKey(b);
      if (aKey === null && bKey === null) {
        const aId = a?.id;
        const bId = b?.id;
        if (typeof aId === "string" && typeof bId === "string") {
          return aId.localeCompare(bId);
        }
        return 0;
      }
      if (aKey === null) {
        return 1;
      }
      if (bKey === null) {
        return -1;
      }
      if (aKey !== bKey) {
        return aKey - bKey;
      }
      const aId = a?.id;
      const bId = b?.id;
      if (typeof aId === "string" && typeof bId === "string") {
        return aId.localeCompare(bId);
      }
      return 0;
    });

    const timelineLines = sortedTimeline.map((moment, idx) =>
      formatTimelineLine(moment, idx)
    );
    const narrativeContext = timelineLines.join("\n\n");

    // 7. LLM Synthesis
    const prompt = `You are analyzing the origin of a specific line of code. A developer wants to understand why this code exists and what decisions led to its creation.

## Code Location
- File: ${file}
- Line: ${line}
- Commit: ${commitHash}
- Pull Request: #${prNumber}
- Repository: ${owner}/${repo}

## Pull Request Information
- Title: ${prData.title || "N/A"}
- Author: ${prData.author || "N/A"}
- Created: ${prData.created_at || "N/A"}
- State: ${prData.state || "N/A"}

## Subject
${root.title}: ${root.summary}

## Timeline of Related Events
${narrativeContext}

## Instructions
Based on the timeline above, explain:
1. What decisions led to this code being written?
2. What was the underlying problem or need that this code addresses?
3. What is the timeline of how this code came to exist?

Rules:
- You MUST only use timestamps that appear at the start of Timeline lines. Do not invent or guess dates.
- When you mention an event, you MUST include the exact timestamp (or timestamp range) that appears on that event's Timeline line.
- You MUST include the data source label when you mention an event (example: the bracketed title prefix like "[GitHub Issue #552]" or "[Discord Thread]" that appears in the Timeline text).
- You MUST NOT mention events, sources, or pull requests/issues that are not present in the Timeline text.
- You MUST NOT try to mention every event in the Timeline. Mention only events needed to answer the questions.
- If a Timeline line includes an importance=0..1 field, prefer higher importance events when selecting which events to mention.
- If the Timeline does not contain enough information to answer part of the question, say that directly.

Write a clear narrative that explains the sequence and causal relationships between events using the Timeline order.`;

    console.log(`[code-origin] Calling LLM to synthesize narrative`);
    const narrative = await callLLM(prompt, "slow-reasoning", {
      temperature: 0,
      reasoning: { effort: "low" },
    });

    return new Response(narrative, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  } catch (error) {
    console.error(
      `[code-origin] Error processing request: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new Response(
      `Failed to process code origin request: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      }
    );
  }
}
