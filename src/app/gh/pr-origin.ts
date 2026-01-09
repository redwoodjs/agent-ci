import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import {
  findAncestors,
  findLastMomentForDocument,
  findDescendants,
  findSimilarMoments,
  findMomentsBySearch,
  getDiagnosticInfo,
  type MomentGraphContext,
} from "@/app/engine/momentDb";
import { getPullRequestsForCommit, parseGitHubRepo } from "./github-utils";
import { callLLM } from "@/app/engine/utils/llm";
import { getEmbedding } from "@/app/engine/utils/vector";
import {
  getMomentGraphNamespaceFromEnv,
  qualifyName,
} from "@/app/engine/momentGraphNamespace";
import type { Moment } from "@/app/engine/types";

interface Citation {
  title: string;
  url: string;
  momentId: string;
  documentId?: string;
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
 * Extract Discord URL from a moment's documentId (R2 key)
 */
function extractDiscordUrlFromDocumentId(documentId: string): string | null {
  // Parse R2 key format for threads: discord/{guildID}/{channelID}/threads/{threadID}/latest.json
  const threadMatch = documentId.match(
    /^discord\/([^\/]+)\/([^\/]+)\/threads\/([^\/]+)\/latest\.json$/
  );
  if (threadMatch) {
    const guildID = threadMatch[1];
    const channelID = threadMatch[2];
    const threadID = threadMatch[3];
    return `discord://channel/${guildID}/${channelID}/thread/${threadID}`;
  }

  // Parse R2 key format for channels: discord/{guildID}/{channelID}/{YYYY-MM-DD}.jsonl
  const channelMatch = documentId.match(
    /^discord\/([^\/]+)\/([^\/]+)\/(\d{4}-\d{2}-\d{2})\.jsonl$/
  );
  if (channelMatch) {
    const guildID = channelMatch[1];
    const channelID = channelMatch[2];
    return `discord://channel/${guildID}/${channelID}`;
  }

  return null;
}

/**
 * Extract Cursor URL from a moment's documentId (R2 key)
 */
function extractCursorUrlFromDocumentId(documentId: string): string | null {
  // Parse R2 key format: cursor/conversations/{conversationId}/latest.json
  const conversationMatch = documentId.match(
    /^cursor\/conversations\/([^\/]+)\/latest\.json$/
  );
  if (conversationMatch) {
    const conversationId = conversationMatch[1];
    return `cursor://conversation/${conversationId}`;
  }

  return null;
}

/**
 * Extract citations from moments in the timeline
 * Extracts URLs from all sources (GitHub, Discord, Cursor)
 */
function extractCitations(moments: Moment[]): Citation[] {
  const citations: Citation[] = [];
  const seenUrls = new Set<string>();

  // Debug: Track source breakdown
  const sourceBreakdown = new Map<string, number>();
  const failedExtractions: string[] = [];

  for (const moment of moments) {
    if (!moment.documentId) continue;

    const source = getSourceType(moment.documentId);
    sourceBreakdown.set(source, (sourceBreakdown.get(source) || 0) + 1);

    // Try GitHub first, then Discord, then Cursor
    let url =
      extractGitHubUrlFromDocumentId(moment.documentId) ||
      extractDiscordUrlFromDocumentId(moment.documentId) ||
      extractCursorUrlFromDocumentId(moment.documentId);

    if (!url) {
      failedExtractions.push(moment.documentId);
      continue;
    }

    if (seenUrls.has(url)) continue;

    seenUrls.add(url);
    citations.push({
      title: moment.title || "Untitled",
      url,
      momentId: moment.id,
      documentId: moment.documentId,
    });
  }

  // Log debugging information
  console.log(
    `[pr-origin:extractCitations] Processing ${moments.length} moments`
  );
  console.log(
    `[pr-origin:extractCitations] Source breakdown:`,
    Object.fromEntries(sourceBreakdown)
  );
  console.log(
    `[pr-origin:extractCitations] Extracted ${citations.length} citations`
  );
  if (failedExtractions.length > 0) {
    console.log(
      `[pr-origin:extractCitations] Failed to extract URLs for ${failedExtractions.length} documentIds:`,
      failedExtractions.slice(0, 10) // Log first 10
    );
  }

  return citations;
}

/**
 * Get source type from documentId (e.g., "github", "discord", "cursor")
 */
function getSourceType(documentId: string): string {
  if (documentId.startsWith("github/")) return "github";
  if (documentId.startsWith("discord/")) return "discord";
  if (documentId.startsWith("cursor/")) return "cursor";
  return "unknown";
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
      namespace?: unknown;
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
    const namespaceOverride =
      typeof body.namespace === "string" ? body.namespace : null;

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
    const momentGraphNamespace =
      namespaceOverride ?? getMomentGraphNamespaceFromEnv(envCloudflare);
    const momentGraphContext: MomentGraphContext = {
      env: envCloudflare,
      momentGraphNamespace: momentGraphNamespace,
    };

    // Log namespace verification details
    // The namespace you provide is combined with base name "moment-graph-v2"
    // to create the full Durable Object name (same as getMomentDb uses)
    const qualifiedDbName = qualifyName(
      "moment-graph-v2",
      momentGraphNamespace
    );
    console.log(
      `[pr-origin] Using namespace: ${momentGraphNamespace ?? "null (default)"}`
    );
    console.log(`[pr-origin] Qualified database name: ${qualifiedDbName}`);

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

      // Always start with direct graph lookup if available
      console.log(
        `[pr-origin] Looking for moment with documentId: ${r2Key} in namespace: ${
          momentGraphContext.momentGraphNamespace ?? "null (default)"
        }`
      );
      console.log(
        `[pr-origin] Searching in qualified database: ${qualifiedDbName}`
      );
      const lastMoment = await findLastMomentForDocument(
        r2Key,
        momentGraphContext
      );
      if (lastMoment) {
        console.log(
          `[pr-origin] Found direct match for PR #${prNumber} in graph: ${lastMoment.id}`
        );
        const ancestors = await findAncestors(
          lastMoment.id,
          momentGraphContext
        );
        console.log(
          `[pr-origin] Found ${ancestors.length} ancestors for PR #${prNumber}`
        );
        const root = ancestors[0] ?? lastMoment;
        const descendants = await findDescendants(root.id, momentGraphContext);
        console.log(
          `[pr-origin] Found ${descendants.length} descendants for PR #${prNumber}`
        );

        allRelatedMoments.push(...ancestors, ...descendants);
      } else {
        console.log(
          `[pr-origin] No direct moment found for PR #${prNumber} with documentId: ${r2Key}`
        );
        console.log(`[pr-origin] DocumentId format being searched: "${r2Key}"`);
      }

      // Always perform additional searches to find unlinked but related moments
      // This ensures we discover Discord threads, Cursor chats, and other sources
      // that may be semantically related but not directly linked in the graph
      console.log(
        `[pr-origin] Performing additional searches for PR #${prNumber} to find related context from all sources...`
      );

      // Search 1: Reference search by PR number (e.g. "PR #804" or "#804")
      const referenceSearch = await findMomentsBySearch(
        `#${prNumber}`,
        momentGraphContext,
        10
      );
      allRelatedMoments.push(...referenceSearch);

      // Log source breakdown for reference search
      const referenceSources = new Map<string, number>();
      for (const moment of referenceSearch) {
        if (moment.documentId) {
          const source = getSourceType(moment.documentId);
          referenceSources.set(source, (referenceSources.get(source) || 0) + 1);
        }
      }
      console.log(
        `[pr-origin] Found ${referenceSearch.length} moments by reference search for PR #${prNumber}`,
        Object.fromEntries(referenceSources)
      );

      // Search 2: Semantic search by PR title/body
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

          // Log source breakdown for semantic search
          const semanticSources = new Map<string, number>();
          for (const moment of similarMoments) {
            if (moment.documentId) {
              const source = getSourceType(moment.documentId);
              semanticSources.set(
                source,
                (semanticSources.get(source) || 0) + 1
              );
            }
          }
          console.log(
            `[pr-origin] Found ${similarMoments.length} moments by semantic search for PR #${prNumber}`,
            Object.fromEntries(semanticSources)
          );
        } catch (err) {
          console.error(
            `[pr-origin] Semantic search failed for PR #${prNumber}:`,
            err
          );
        }
      }

      // Diagnostic queries when no results found
      if (allRelatedMoments.length === 0) {
        console.log(
          `[pr-origin:diagnostics] No moments found for PR #${prNumber}, running diagnostic queries...`
        );

        try {
          const diagnosticInfo = await getDiagnosticInfo(momentGraphContext, [
            String(prNumber),
            `pull-requests/${prNumber}`,
          ]);

          console.log(
            `[pr-origin:diagnostics] Total moments in namespace "${
              momentGraphNamespace ?? "default"
            }": ${diagnosticInfo.totalMoments}`
          );
          console.log(
            `[pr-origin:diagnostics] Found ${diagnosticInfo.matchingDocumentIds.length} moments with matching documentIds:`,
            diagnosticInfo.matchingDocumentIds.map((m) => m.documentId)
          );
        } catch (diagError) {
          console.error(
            `[pr-origin:diagnostics] Error running diagnostic queries:`,
            diagError
          );
        }
      }
    }

    // 3. deduplicate and build timeline
    const uniqueMomentsMap = new Map<string, Moment>();
    for (const m of allRelatedMoments) {
      uniqueMomentsMap.set(m.id, m);
    }

    // Log final source breakdown
    const finalSources = new Map<string, number>();
    for (const moment of uniqueMomentsMap.values()) {
      if (moment.documentId) {
        const source = getSourceType(moment.documentId);
        finalSources.set(source, (finalSources.get(source) || 0) + 1);
      }
    }
    console.log(
      `[pr-origin] Final timeline contains ${uniqueMomentsMap.size} unique moments from sources:`,
      Object.fromEntries(finalSources)
    );
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
Based on the information provided above (Code Location, Related Pull Requests, and Timeline), provide your response in the following format. **YOU MUST INCLUDE BOTH SECTIONS:**

### TL;DR
[Write a concise 2-3 sentence summary that captures the essence of how this code evolved and why it exists in its current form. Focus on the key decisions and problems addressed. This section is MANDATORY and must be included.]

### Full Analysis
[Write a detailed narrative that explains:]
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
- IMPORTANT: The Timeline may contain events from multiple sources (GitHub PRs/issues, Discord threads, Cursor chats, etc.). When available, actively incorporate information from all these sources to provide a comprehensive narrative. Discord threads and Cursor chats often contain valuable context and discussions that influenced the code decisions, even if they are not directly linked in the graph.

Write a clear narrative that explains the sequence and causal relationships between events and pull requests, drawing from all available sources in the Timeline.`;

    console.log(
      `[pr-origin] Calling LLM to synthesize narrative for ${prNumbers.length} PRs`
    );
    const fullResponse = await callLLM(prompt, "slow-reasoning", {
      temperature: 0,
      reasoning: { effort: "low" },
    });

    // Parse TL;DR and narrative from the response
    // Try multiple patterns to extract TLDR
    let tldr = "";
    let narrative = fullResponse;

    // Pattern 1: ### TL;DR (current format)
    let tldrMatch = fullResponse.match(
      /###\s*TL;DR\s*\n([\s\S]*?)(?=\n###\s*Full\s*Analysis|$)/i
    );
    
    // Pattern 2: ## TL;DR (alternative heading level)
    if (!tldrMatch) {
      tldrMatch = fullResponse.match(
        /##\s*TL;DR\s*\n([\s\S]*?)(?=\n##\s*Full\s*Analysis|$)/i
      );
    }
    
    // Pattern 3: **TL;DR** (bold format)
    if (!tldrMatch) {
      tldrMatch = fullResponse.match(
        /\*\*TL;DR\*\*:?\s*\n([\s\S]*?)(?=\n\*\*Full\s*Analysis\*\*|$)/i
      );
    }
    
    // Pattern 4: TL;DR: (plain format)
    if (!tldrMatch) {
      tldrMatch = fullResponse.match(
        /TL;DR:?\s*\n([\s\S]*?)(?=\n(?:Full\s*Analysis|###|##|$))/i
      );
    }

    if (tldrMatch) {
      tldr = tldrMatch[1].trim();
      console.log(`[pr-origin] Successfully extracted TLDR (${tldr.length} chars)`);
    } else {
      console.log(`[pr-origin] No explicit TLDR section found, using fallback extraction`);
      // Fallback: Extract first 2-3 sentences from the response
      const sentences = fullResponse
        .replace(/###\s*Full\s*Analysis[\s\S]*$/i, "") // Remove Full Analysis section if present
        .trim()
        .split(/[.!?]+/)
        .filter((s) => s.trim().length > 0)
        .slice(0, 3)
        .map((s) => s.trim() + ".");
      
      if (sentences.length > 0) {
        tldr = sentences.join(" ");
        console.log(`[pr-origin] Generated fallback TLDR from first ${sentences.length} sentences`);
      } else {
        // Last resort: use first paragraph or first 200 chars
        const firstPart = fullResponse
          .replace(/###\s*Full\s*Analysis[\s\S]*$/i, "")
          .trim()
          .split("\n\n")[0]
          .substring(0, 200)
          .trim();
        tldr = firstPart || "Summary not available.";
        console.log(`[pr-origin] Generated fallback TLDR from first paragraph`);
      }
    }

    const fullAnalysisMatch = fullResponse.match(
      /###\s*Full\s*Analysis\s*\n([\s\S]*?)$/i
    );

    if (fullAnalysisMatch) {
      narrative = fullAnalysisMatch[1].trim();
    } else if (!tldrMatch) {
      // If no sections found, use the whole response as narrative
      narrative = fullResponse.trim();
    } else {
      // If TLDR was found but Full Analysis wasn't, extract everything after TLDR
      const afterTldr = fullResponse.substring(
        (tldrMatch.index || 0) + tldrMatch[0].length
      ).trim();
      narrative = afterTldr || fullResponse.trim();
    }

    // Extract citations from the timeline moments
    console.log(
      `[pr-origin] Extracting citations from ${sortedTimeline.length} timeline moments`
    );
    console.log(
      `[pr-origin] Sample documentIds:`,
      sortedTimeline.slice(0, 5).map((m) => m.documentId || "NO_DOCUMENT_ID")
    );
    const citations = extractCitations(sortedTimeline);
    console.log(`[pr-origin] Extracted ${citations.length} citations total`);

    // Return JSON response with TLDR, narrative, citations, commits, and PRs
    // Ensure TLDR is always present (never null)
    const response = {
      TLDR: tldr || "Summary not available.",
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
