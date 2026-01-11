import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { fetchRelatedMomentsForCodeTimeline } from "../actions";
import { EvolutionTable } from "./evolution-table";
import { SourceType } from "./types";

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
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
                <strong>namespace</strong> (optional): Moment graph namespace to
                query
              </li>
            </ul>
            <div className="mt-4 p-4 bg-gray-50 rounded">
              <p className="text-sm font-mono">
                Example URL:
                <br />
                /audit/tldr?repo=owner/repo&commit=abc123&file=src/app/file.ts:42
                <br />
                /audit/tldr?repo=owner/repo&commit=abc123&file=src/app/file.ts:42&namespace=my-namespace
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">TL;DR</h1>

      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle>Querying the knowledge graph...</CardTitle>
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
        <RelatedMomentsLoader
          repo={repo}
          commit={commit}
          namespace={namespace}
          file={file}
          line={line}
        />
      </Suspense>
    </div>
  );
}

async function RelatedMomentsLoader({
  repo,
  commit,
  namespace,
  file,
  line,
}: {
  repo: string;
  commit: string;
  namespace: string | null;
  file: string;
  line: number;
}) {
  const timelineResult = await fetchRelatedMomentsForCodeTimeline({
    repo,
    commit,
    namespace: namespace || undefined,
  });

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

  return (
    <EvolutionSection
      sortedTimeline={sortedTimeline}
      repo={repo}
      file={file}
      line={line}
    />
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

    const event = moment.title || "Untitled";
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
      <div className="bg-slate-50 border-b border-slate-200 px-6 py-4">
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest relative inline-block">
          Evolution of the code
          <div className="absolute -bottom-1 left-0 w-full h-1 bg-blue-500/30 rounded-full"></div>
        </h3>
      </div>
      <EvolutionTable data={evolutionData} functionName={fileLocation} />
      <div className="bg-indigo-50/30 px-6 py-4 border-t border-slate-100">
        <p className="text-[10px] text-indigo-500 font-medium leading-relaxed italic">
          Note: This timeline shows the evolution of the code based on related
          pull requests, issues, and discussions found in the knowledge graph.
        </p>
      </div>
    </div>
  );
}

async function DevelopmentStreamSection({
  repo,
  commit,
  namespace,
}: {
  repo: string;
  commit: string;
  namespace: string | null;
}) {
  const timelineResult = await fetchRelatedMomentsForCodeTimeline({
    repo,
    commit,
    namespace: namespace || undefined,
  });

  if (!timelineResult.success) {
    return (
      <Card className="border-red-500">
        <CardHeader>
          <CardTitle className="text-red-600">
            Error Loading Development Stream
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-600">{timelineResult.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { developmentStream } = timelineResult;

  if (developmentStream.length === 0) {
    return (
      <Card className="border-l-4 border-l-purple-500">
        <CardHeader>
          <CardTitle className="text-2xl">Development Stream</CardTitle>
          <CardDescription>
            Timeline of related events and discussions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600">No development stream data available.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-l-4 border-l-purple-500">
      <CardHeader>
        <CardTitle className="text-2xl">Development Stream</CardTitle>
        <CardDescription>
          Timeline of related events and discussions
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {developmentStream.map((moment: any, idx: number) => (
            <div
              key={moment.id || idx}
              className="border-l-2 border-gray-200 pl-4 py-2"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h4 className="font-semibold text-gray-900">
                    {moment.title}
                  </h4>
                  {moment.summary && (
                    <p className="text-sm text-gray-600 mt-1">
                      {moment.summary}
                    </p>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                    {moment.createdAt && (
                      <span>
                        {new Date(moment.createdAt).toLocaleDateString()}
                      </span>
                    )}
                    {moment.importance !== undefined && (
                      <span>
                        Importance: {(moment.importance * 100).toFixed(0)}%
                      </span>
                    )}
                    {moment.documentId && (
                      <span className="font-mono text-xs">
                        {moment.documentId.split("/").pop()}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

async function KeyDecisionsSection({
  repo,
  commit,
  namespace,
}: {
  repo: string;
  commit: string;
  namespace: string | null;
}) {
  const timelineResult = await fetchRelatedMomentsForCodeTimeline({
    repo,
    commit,
    namespace: namespace || undefined,
  });

  if (!timelineResult.success) {
    return (
      <Card className="border-red-500">
        <CardHeader>
          <CardTitle className="text-red-600">
            Error Loading Key Decisions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-600">{timelineResult.error}</p>
        </CardContent>
      </Card>
    );
  }

  const { developmentStream } = timelineResult;

  // Extract key decisions from high-importance moments
  const keyDecisions = developmentStream
    .filter((moment: any) => moment.importance && moment.importance >= 0.8)
    .sort((a: any, b: any) => (b.importance || 0) - (a.importance || 0))
    .slice(0, 10);

  if (keyDecisions.length === 0) {
    return (
      <Card className="border-l-4 border-l-orange-500">
        <CardHeader>
          <CardTitle className="text-2xl">Key Decisions</CardTitle>
          <CardDescription>
            High-impact decisions and discussions that shaped this code
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600">No key decisions found.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-l-4 border-l-orange-500">
      <CardHeader>
        <CardTitle className="text-2xl">Key Decisions</CardTitle>
        <CardDescription>
          High-impact decisions and discussions that shaped this code
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {keyDecisions.map((moment: any, idx: number) => (
            <div
              key={moment.id || idx}
              className="border-l-2 border-orange-300 pl-4 py-2 bg-orange-50 rounded-r"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h4 className="font-semibold text-gray-900">
                    {moment.title}
                  </h4>
                  {moment.summary && (
                    <p className="text-sm text-gray-700 mt-1">
                      {moment.summary}
                    </p>
                  )}
                  <div className="flex items-center gap-4 mt-2 text-xs text-gray-600">
                    {moment.createdAt && (
                      <span>
                        {new Date(moment.createdAt).toLocaleDateString()}
                      </span>
                    )}
                    {moment.importance !== undefined && (
                      <span className="font-semibold">
                        Impact: {(moment.importance * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
