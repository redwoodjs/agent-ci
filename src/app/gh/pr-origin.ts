import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import {
  findAncestors,
  findLastMomentForDocument,
  findDescendants,
  findSimilarMoments,
  findMomentsBySearch,
  type MomentGraphContext,
} from "@/app/engine/momentDb";
import { getPullRequestsForCommit, parseGitHubRepo } from "./github-utils";
import { callLLM } from "@/app/engine/utils/llm";
import { getEmbedding } from "@/app/engine/utils/vector";
import { getMomentGraphNamespaceFromEnv } from "@/app/engine/momentGraphNamespace";
import type { Moment } from "@/app/engine/types";

interface Citation {
  title: string;
  url: string;
  momentId: string;
}

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

/**
 * Extract GitHub URL from a moment's documentId (R2 key)
 */
function extractGitHubUrlFromDocumentId(documentId: string): string | null {
  // Parse R2 key format: github/owner/repo/pull-requests/123/latest.json
  // or: github/owner/repo/issues/123/latest.json
  // or: github/owner/projects/123/latest.json
  const prIssueMatch = documentId.match(
    /^github\/([^\/]+)\/([^\/]+)\/(pull-requests|issues)\/(\d+)\/latest\.json$/
  );
  if (prIssueMatch) {
    const owner = prIssueMatch[1];
    const repo = prIssueMatch[2];
    const type = prIssueMatch[3];
    const number = prIssueMatch[4];
    return `https://github.com/${owner}/${repo}/${
      type === "pull-requests" ? "pull" : "issues"
    }/${number}`;
  }

  const projectMatch = documentId.match(
    /^github\/([^\/]+)\/projects\/(\d+)\/latest\.json$/
  );
  if (projectMatch) {
    const owner = projectMatch[1];
    const number = projectMatch[2];
    return `https://github.com/orgs/${owner}/projects/${number}`;
  }

  return null;
}

/**
 * Extract citations from moments in the timeline
 */
function extractCitations(moments: Moment[]): Citation[] {
  const citations: Citation[] = [];
  const seenUrls = new Set<string>();

  for (const moment of moments) {
    if (!moment.documentId) continue;

    const url = extractGitHubUrlFromDocumentId(moment.documentId);
    if (!url || seenUrls.has(url)) continue;

    seenUrls.add(url);
    citations.push({
      title: moment.title || "Untitled",
      url,
      momentId: moment.id,
    });
  }

  return citations;
}

export async function prOriginHandler({ request, ctx }: RequestInfo) {
  console.log(`[pr-origin] Handler called: ${request.method} ${request.url}`);

  if (request.method !== "POST") {
    console.log(`[pr-origin] Method not allowed: ${request.method}`);
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    let body: {
      commitHashes?: unknown;
      commitHash?: unknown; // Backward compatibility
      repo?: unknown;
      file?: unknown;
      line?: unknown;
      codeContent?: unknown;
      context?: unknown;
    } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }

    // Support both single commitHash and array of commitHashes
    const commitHashes = Array.isArray(body.commitHashes)
      ? (body.commitHashes as string[])
      : typeof body.commitHash === "string"
      ? [body.commitHash]
      : null;

    const repoInput = typeof body.repo === "string" ? body.repo : null;
    const file = typeof body.file === "string" ? body.file : null;
    const line = typeof body.line === "number" ? body.line : null;
    const codeContent =
      typeof body.codeContent === "string" ? body.codeContent : null;
    const context = typeof body.context === "string" ? body.context : null;

    if (!commitHashes || commitHashes.length === 0 || !repoInput) {
      return new Response(
        "Missing required parameters: commitHashes (or commitHash), repo",
        {
          status: 400,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }
      );
    }

    // Parse repository identifier
    const parsedRepo = parseGitHubRepo(repoInput);
    if (!parsedRepo) {
      return new Response(
        `Invalid repository format: ${repoInput}. Expected formats: owner/repo, https://github.com/owner/repo.git, or git@github.com:owner/repo.git`,
        {
          status: 400,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }
      );
    }

    const { owner, repo } = parsedRepo;
    const envCloudflare = env as Cloudflare.Env;

    // 1. Get all unique PR numbers for all commits
    console.log(
      `[pr-origin] Fetching PRs for ${commitHashes.length} commits in ${owner}/${repo}`
    );

    const prNumbersSet = new Set<number>();
    for (const hash of commitHashes) {
      try {
        const prs = await getPullRequestsForCommit(
          owner,
          repo,
          hash,
          envCloudflare
        );
        for (const pr of prs) {
          prNumbersSet.add(pr);
        }
      } catch (err) {
        console.warn(
          `[pr-origin] Failed to fetch PRs for commit ${hash}:`,
          err
        );
      }
    }

    const prNumbers = Array.from(prNumbersSet).sort((a, b) => b - a);

    if (prNumbers.length === 0) {
      return new Response(
        `No pull requests found for the provided commits in ${owner}/${repo}`,
        {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
          },
        }
      );
    }

    console.log(
      `[pr-origin] Found ${prNumbers.length} unique PRs: ${prNumbers.join(
        ", "
      )}`
    );

    // 2. Fetch data for each PR from R2 and find moments in the graph
    const bucket = envCloudflare.MACHINEN_BUCKET;
    const momentGraphNamespace = getMomentGraphNamespaceFromEnv(envCloudflare);
    const momentGraphContext: MomentGraphContext = {
      env: envCloudflare,
      momentGraphNamespace: momentGraphNamespace,
    };

    const allRelatedMoments: Moment[] = [];
    const prSummaries: string[] = [];

    for (const prNumber of prNumbers) {
      const r2Key = `github/${owner}/${repo}/pull-requests/${prNumber}/latest.json`;
      const prObject = await bucket.get(r2Key);

      if (!prObject) {
        console.warn(`[pr-origin] PR data not found in R2: ${r2Key}`);
        continue;
      }

      const prData = (await prObject.json()) as any;
      prSummaries.push(
        `- PR #${prNumber}: ${prData.title || "N/A"} (Author: ${
          prData.author || "N/A"
        }, Created: ${prData.created_at || "N/A"})`
      );

      const lastMoment = await findLastMomentForDocument(
        r2Key,
        momentGraphContext
      );
      if (lastMoment) {
        console.log(
          `[pr-origin] Found direct match for PR #${prNumber} in graph`
        );
        const ancestors = await findAncestors(
          lastMoment.id,
          momentGraphContext
        );
        const root = ancestors[0] ?? lastMoment;
        const descendants = await findDescendants(root.id, momentGraphContext);

        allRelatedMoments.push(...ancestors, ...descendants);
      } else {
        console.log(
          `[pr-origin] PR #${prNumber} not indexed. Searching for related moments...`
        );

        // Fallback 1: Search by PR reference (e.g. "PR #804")
        const referenceSearch = await findMomentsBySearch(
          `#${prNumber}`,
          momentGraphContext,
          10
        );
        allRelatedMoments.push(...referenceSearch);
        console.log(
          `[pr-origin] Found ${referenceSearch.length} moments by reference search for PR #${prNumber}`
        );

        // Fallback 2: Semantic search by PR title/body
        const queryText = `${prData.title || ""}\n\n${
          prData.body || ""
        }`.substring(0, 1000);
        if (queryText.trim().length > 0) {
          try {
            const embedding = await getEmbedding(queryText);
            const similarMoments = await findSimilarMoments(
              embedding,
              10,
              momentGraphContext
            );
            allRelatedMoments.push(...similarMoments);
            console.log(
              `[pr-origin] Found ${similarMoments.length} moments by semantic search for PR #${prNumber}`
            );
          } catch (err) {
            console.error(
              `[pr-origin] Semantic search failed for PR #${prNumber}:`,
              err
            );
          }
        }
      }
    }

    // 3. deduplicate and build timeline
    const uniqueMomentsMap = new Map<string, Moment>();
    for (const m of allRelatedMoments) {
      uniqueMomentsMap.set(m.id, m);
    }
    const sortedTimeline = Array.from(uniqueMomentsMap.values()).sort(
      (a, b) => {
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
        if (aKey === null) return 1;
        if (bKey === null) return -1;
        if (aKey !== bKey) return aKey - bKey;

        const aId = a?.id;
        const bId = b?.id;
        if (typeof aId === "string" && typeof bId === "string") {
          return aId.localeCompare(bId);
        }
        return 0;
      }
    );

    const timelineLines = sortedTimeline.map((moment, idx) =>
      formatTimelineLine(moment, idx)
    );
    const narrativeContext =
      timelineLines.length > 0
        ? timelineLines.join("\n\n")
        : "No related events found in the knowledge base for these pull requests yet.";

    // 4. LLM Synthesis
    // Build code location section if code context is available
    const codeLocationSection =
      file && line !== null
        ? `## Code Location
- File: ${file}
- Line: ${line}
${codeContent ? `- Code: ${codeContent}` : ""}
${context ? `- Context: ${context}` : ""}

`
        : "";

    const prompt = `You are analyzing the evolution and origin of ${
      file && line !== null ? "this specific code" : "a specific piece of code"
    }. A developer wants to understand what decisions led to the current state of this code and what problems were addressed across its history.

${codeLocationSection}## Repository: ${owner}/${repo}

## Related Pull Requests
${prSummaries.join("\n")}

## Timeline of Related Events (Combined from all PRs)
${narrativeContext}

## Instructions
Based on the information provided above (Code Location, Related Pull Requests, and Timeline), explain:
1. How has ${
      file && line !== null ? "this specific code" : "this code"
    } evolved over time across these different pull requests?
2. What were the key decisions or problems that triggered each major change to ${
      file && line !== null ? "this code" : "this piece of code"
    }?
3. What is the overarching narrative of how ${
      file && line !== null ? "this specific code" : "this piece of code"
    } came to exist in its current form?
4. What related discussions, issues, or decisions influenced ${
      file && line !== null ? "this code" : "this code"
    } at different stages?

Rules:
- You MUST only use timestamps that appear at the start of Timeline lines or in Pull Request Information. Do not invent or guess dates.
- When you mention a Timeline event, you MUST include the exact timestamp (or timestamp range) that appears on that event's Timeline line.
- When you mention a Pull Request, you MUST include its number and the provided metadata (author, title, etc.).
- You MUST include the data source label when you mention a Timeline event (example: the bracketed title prefix like "[GitHub Issue #552]" or "[Discord Thread]").
- You MUST NOT mention events, sources, or pull requests/issues that are not present in the text above.
- Mention only events and PRs needed to answer the questions.
- If a Timeline line includes an importance=0..1 field, prefer higher importance events.
- If information is missing for part of the question, say so directly.

Write a clear narrative that explains the sequence and causal relationships between events and pull requests.`;

    console.log(
      `[pr-origin] Calling LLM to synthesize narrative for ${prNumbers.length} PRs`
    );
    const narrative = await callLLM(prompt, "slow-reasoning", {
      temperature: 0,
      reasoning: { effort: "low" },
    });

    // Extract citations from the timeline moments
    const citations = extractCitations(sortedTimeline);

    // Return JSON response with narrative, citations, commits, and PRs
    const response = {
      narrative,
      citations,
      commitHashes,
      prNumbers,
    };

    return new Response(JSON.stringify(response, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    console.error(
      `[pr-origin] Error processing request: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new Response(
      `Failed to process PR origin request: ${
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
