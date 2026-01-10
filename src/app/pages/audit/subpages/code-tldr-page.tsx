import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { fetchCodeTimeline } from "./actions";
import { TldrSection } from "./tldr-section";
import { EvolutionTable } from "./evolution-table";

export type SourceType =
  | "GitHub PR"
  | "GitHub Issue"
  | "Release"
  | "Discord"
  | "Cursor"
  | "Unknown";

export const SourceIcon = ({
  type,
  className,
}: {
  type: SourceType;
  className?: string;
}) => {
  switch (type) {
    case "GitHub PR":
    case "GitHub Issue":
    case "Release":
      return (
        <svg
          className={className}
          fill="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
      );
    case "Discord":
      return (
        <svg
          className={className}
          fill="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
        </svg>
      );
    case "Cursor":
      return (
        <svg
          className={className}
          fill="currentColor"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
        </svg>
      );
    default:
      return null;
  }
};

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

function extractFunctionName(file: string): string {
  // Extract function name from file path, or use filename
  const fileName = file.split("/").pop() || file;
  // Remove extension
  return fileName.replace(/\.[^/.]+$/, "");
}

export function CodeTldrPage({ request }: { request: Request }) {
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

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Input Parameters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <span className="font-medium text-gray-700">Repository:</span>{" "}
              <span className="font-mono">{repo}</span>
            </div>
            <div>
              <span className="font-medium text-gray-700">Commit:</span>{" "}
              <span className="font-mono">{commit}</span>
            </div>
            <div>
              <span className="font-medium text-gray-700">File:</span>{" "}
              <span className="font-mono">{file}</span>
            </div>
            <div>
              <span className="font-medium text-gray-700">Line:</span>{" "}
              <span className="font-mono">{line}</span>
            </div>
            {namespace && (
              <div>
                <span className="font-medium text-gray-700">Namespace:</span>{" "}
                <span className="font-mono">{namespace}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle>Loading Evolution...</CardTitle>
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
        <EvolutionSection
          repo={repo}
          commit={commit}
          namespace={namespace}
          file={file}
          line={line}
        />
      </Suspense>

      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle>Loading Development Stream...</CardTitle>
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
        <DevelopmentStreamSection
          repo={repo}
          commit={commit}
          namespace={namespace}
        />
      </Suspense>

      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle>Loading Key Decisions...</CardTitle>
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
        <KeyDecisionsSection
          repo={repo}
          commit={commit}
          namespace={namespace}
        />
      </Suspense>

      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle>Generating TL;DR...</CardTitle>
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
        <TldrSection
          repo={repo}
          commit={commit}
          file={file}
          line={line}
          namespace={namespace}
        />
      </Suspense>
    </div>
  );
}

async function EvolutionSection({
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
  const timelineResult = await fetchCodeTimeline({
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

  // Use the narrative from the timeline if available, or generate a summary
  const sortedTimeline = (timelineResult as any).sortedTimeline || [];

  if (sortedTimeline.length === 0) {
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

    // For cursor conversations, use timeRange.start for more granular timestamps
    // Otherwise fall back to createdAt
    const timeRange = moment.sourceMetadata?.timeRange;
    const timestamp = timeRange?.start || moment.createdAt;
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
  const timelineResult = await fetchCodeTimeline({
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

  const developmentStream = (timelineResult as any).developmentStream || [];

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
  const timelineResult = await fetchCodeTimeline({
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

  const developmentStream = (timelineResult as any).developmentStream || [];

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
