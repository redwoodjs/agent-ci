import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { fetchCodeTimeline, transformTimelineToHeatmapData } from "../actions";
import { EvolutionTable } from "./evolution-table";
import { SourceType } from "./types";
import { TldrSection } from "./tldr-section";
import { DecisionGridSection } from "./decision-grid";
import { TimelineHeatmapWrapper } from "./timeline-heatmap-wrapper";

function getSourceTypeFromDocumentId(
  documentId: string | null | undefined
): SourceType {
  if (!documentId) return "Unknown";
  if (documentId.startsWith("github/")) {
    // Try to determine if it's a PR, Issue, or Release from the path
    if (documentId.includes("/pull-requests/")) return "GitHub PR";
    if (documentId.includes("/issues/")) return "GitHub Issue";
    if (documentId.includes("/releases/")) return "Release";
    return "GitHub PR"; // Default to PR for github sources
  }
  if (documentId.startsWith("discord/")) return "Discord";
  if (documentId.startsWith("cursor/")) return "Cursor";
  return "Unknown";
}

function getSourceLabel(
  documentId: string | null | undefined,
  sourceMetadata: any
): string {
  if (!documentId) return "Unknown";

  // Extract PR number, issue number, or release tag from documentId
  if (documentId.includes("/pull-requests/")) {
    const match = documentId.match(/\/pull-requests\/(\d+)/);
    if (match) return `PR #${match[1]}`;
  }
  if (documentId.includes("/issues/")) {
    const match = documentId.match(/\/issues\/(\d+)/);
    if (match) return `Issue #${match[1]}`;
  }
  if (documentId.includes("/releases/")) {
    const parts = documentId.split("/");
    const releasePart = parts[parts.length - 1];
    if (releasePart && releasePart !== "latest.json") {
      return releasePart.replace(".json", "");
    }
    return "Release";
  }
  if (documentId.startsWith("discord/")) {
    return "Discord";
  }
  if (documentId.startsWith("cursor/")) {
    return "Cursor";
  }

  return documentId.split("/").pop()?.replace(".json", "") || "Unknown";
}

function getSourceUrl(
  documentId: string | null | undefined,
  repo: string
): string | null {
  if (!documentId) return null;

  // For sources stored in R2 (Cursor and Discord), link to the ingestion file page
  if (documentId.startsWith("cursor/") || documentId.startsWith("discord/")) {
    return `/audit/ingestion/file/${encodeURIComponent(documentId)}`;
  }

  // Extract PR/Issue number or release tag and construct GitHub URL
  if (documentId.includes("/pull-requests/")) {
    const match = documentId.match(/\/pull-requests\/(\d+)/);
    if (match) {
      return `https://github.com/${repo}/pull/${match[1]}`;
    }
  }
  if (documentId.includes("/issues/")) {
    const match = documentId.match(/\/issues\/(\d+)/);
    if (match) {
      return `https://github.com/${repo}/issues/${match[1]}`;
    }
  }
  if (documentId.includes("/releases/")) {
    const parts = documentId.split("/");
    const releasePart = parts[parts.length - 1]?.replace(".json", "");
    if (releasePart && releasePart !== "latest") {
      return `https://github.com/${repo}/releases/tag/${releasePart}`;
    }
  }

  return null;
}

export function CodePage({ request }: { request: Request }) {
  const url = new URL(request.url);
  const repo = url.searchParams.get("repo") || "";
  const commit = url.searchParams.get("commit") || "";
  const fileParam = url.searchParams.get("file") || "";
  const namespace = url.searchParams.get("namespace") || null;

  // Parse file parameter (format: filename.ext:line)
  let file = "";
  let line = 0;
  if (fileParam) {
    const colonIndex = fileParam.lastIndexOf(":");
    if (colonIndex > 0) {
      file = fileParam.substring(0, colonIndex);
      const lineStr = fileParam.substring(colonIndex + 1);
      line = Number.parseInt(lineStr, 10) || 0;
    } else {
      file = fileParam;
    }
  }

  // Validate required parameters
  if (!repo || !commit || !file || line <= 0) {
    return (
      <div className="min-h-screen bg-white text-slate-900 p-8">
        <div className="max-w-7xl mx-auto">
          <Card className="border-red-500">
            <CardHeader>
              <CardTitle className="text-red-600">Missing Parameters</CardTitle>
              <CardDescription>
                Please provide all required query parameters:
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="list-disc list-inside space-y-2 text-sm">
                <li>
                  <strong>repo</strong>: Repository in format owner/repo (e.g.,
                  "redwoodjs/redwood")
                </li>
                <li>
                  <strong>commit</strong>: Commit hash (e.g., "abc123def456")
                </li>
                <li>
                  <strong>file</strong>: File path with line number in format
                  filename.ext:line (e.g., "src/app/file.ts:42")
                </li>
                <li>
                  <strong>namespace</strong> (optional): Moment graph namespace
                  to query
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-3xl font-bold mb-8">TL;DR</h1>

        <Suspense
          fallback={
            <Card>
              <CardHeader>
                <CardTitle>Loading timeline data...</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                </div>
              </CardContent>
            </Card>
          }
        >
          <CodePageContent
            repo={repo}
            commit={commit}
            file={file}
            line={line}
            namespace={namespace}
          />
        </Suspense>
      </div>
    </div>
  );
}

async function CodePageContent({
  repo,
  commit,
  file,
  line,
  namespace,
}: {
  repo: string;
  commit: string;
  file: string;
  line: number;
  namespace: string | null;
}) {
  // Fetch timeline data once at the top level
  const timelineResult = await fetchCodeTimeline({
    repo,
    commit,
    namespace: namespace || undefined,
  });

  return (
    <>
      {/* TLDR */}
      {/* <TldrSection
        repo={repo}
        commit={commit}
        file={file}
        line={line}
        namespace={namespace}
        timelineResult={timelineResult}
      /> */}

      <RelatedMomentsLoader
        repo={repo}
        commit={commit}
        namespace={namespace}
        file={file}
        line={line}
        timelineResult={timelineResult}
      />

      {/* <DecisionGridSection repo={repo} commit={commit} namespace={namespace} /> */}
    </>
  );
}

async function RelatedMomentsLoader({
  repo,
  commit,
  namespace,
  file,
  line,
  timelineResult,
}: {
  repo: string;
  commit: string;
  namespace: string | null;
  file: string;
  line: number;
  timelineResult: Awaited<ReturnType<typeof fetchCodeTimeline>>;
}) {
  if (!timelineResult.success) {
    return (
      <Card className="border-red-500">
        <CardHeader>
          <CardTitle className="text-red-600">
            Error Loading Evolution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-600">{timelineResult.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { sortedTimeline } = timelineResult;

  // Transform timeline for heatmap
  const heatmapData = transformTimelineToHeatmapData(sortedTimeline || []);

  return (
    <>
      {/* Timeline and Heatmap with interactive linking */}
      <TimelineHeatmapWrapper
        heatmapData={heatmapData}
        moments={sortedTimeline || []}
        repo={repo}
        compressThreshold={2}
      />

      {/* Evolution Table */}
      {/* <EvolutionSection
        sortedTimeline={sortedTimeline || []}
        repo={repo}
        file={file}
        line={line}
      /> */}
    </>
  );
}

function EvolutionSection({
  sortedTimeline,
  repo,
  file,
  line,
}: {
  sortedTimeline: any[];
  repo: string;
  file: string;
  line: number;
}) {
  if (!sortedTimeline || sortedTimeline.length === 0) {
    return (
      <div className="mb-12 overflow-hidden border border-slate-200 rounded-xl bg-white shadow-sm">
        <div className="bg-slate-50 border-b border-slate-200 px-6 py-4">
          <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest relative inline-block">
            Evolution of the code
            <div className="absolute -bottom-1 left-0 w-full h-1 bg-blue-500/30 rounded-full"></div>
          </h3>
        </div>
        <div className="px-6 py-8 text-center">
          <p className="text-gray-600">No evolution data available.</p>
        </div>
      </div>
    );
  }

  // Transform timeline data into table format
  const evolutionData = sortedTimeline.map((moment: any) => {
    const sourceType = getSourceTypeFromDocumentId(moment.documentId);
    const source = getSourceLabel(moment.documentId, moment.sourceMetadata);
    const url = getSourceUrl(moment.documentId, repo);

    // For cursor conversations, we normalized moment.createdAt to the R2 uploaded date
    // in actions.ts. We should use it directly and ignore timeRange.start for cursor.
    // For other sources, we still prefer timeRange.start for granularity.
    const timeRange = moment.sourceMetadata?.timeRange;
    const timestamp =
      sourceType === "Cursor"
        ? moment.createdAt
        : timeRange?.start || moment.createdAt;
    const date = timestamp
      ? new Date(timestamp).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "Unknown date";

    // Remove [Cursor Conversation] prefix from titles since we show the icon in the source badge
    let event = moment.title || "Untitled";
    if (sourceType === "Cursor" && event.startsWith("[Cursor Conversation]")) {
      event =
        event.replace(/^\[Cursor Conversation\]\s*/, "").trim() || "Untitled";
    }
    const impact = moment.summary || "No impact description available.";

    return {
      date,
      sourceType,
      source,
      url,
      event,
      impact,
    };
  });

  const fileName = file.split("/").pop() || file;
  const fileLocation = `${fileName}:${line}`;

  return (
    <div className="mb-12 overflow-hidden border border-slate-200 rounded-xl bg-white shadow-sm">
      <EvolutionTable data={evolutionData} functionName={fileLocation} />
      <div className="bg-slate-50/50 px-6 py-3 border-t border-slate-100 text-center">
        <p className="text-[10px] text-slate-400 font-medium italic">
          Note: This timeline shows the evolution of the code based on related
          pull requests, issues, and discussions found in the knowledge graph.
        </p>
      </div>
    </div>
  );
}
