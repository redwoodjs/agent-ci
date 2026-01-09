import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { generateCodeTldr, fetchCodeTimeline } from "./actions";
import { TimelineSection } from "./timeline-section";
import { DecisionGrid, Decision } from "./decision-grid";

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
      <div className="mb-6">
        <a
          href="/audit"
          className="text-blue-600 hover:text-blue-800 text-sm font-medium"
        >
          ← Back to Audit Dashboard
        </a>
      </div>

      <h1 className="text-3xl font-bold mb-8">Code TL;DR</h1>

      <Card className="mb-6">
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

      {/* Timeline Sections - Display immediately */}
      <TimelineContent
        repo={repo}
        commit={commit}
        file={file}
        namespace={namespace}
      />

      {/* TLDR Section - Wait for LLM */}
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
        <TldrContent
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

async function TimelineContent({
  repo,
  commit,
  file,
  namespace,
}: {
  repo: string;
  commit: string;
  file: string;
  namespace: string | null;
}) {
  const timelineResult = await fetchCodeTimeline({
    repo,
    commit,
    namespace: namespace || undefined,
  });

  if (!timelineResult.success) {
    return (
      <div className="space-y-6">
        <Card className="border-red-500">
          <CardHeader>
            <CardTitle className="text-red-600">
              Error Loading Timeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-red-600">{timelineResult.error}</p>
            {timelineResult.details && (
              <p className="text-sm text-gray-600 mt-2">
                {timelineResult.details}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const formatDateShort = (dateString: string | null | undefined): string => {
    if (!dateString) return "N/A";
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return dateString;
    }
  };

  const getSourceTypeFromDocumentId = (
    documentId: string | null | undefined
  ):
    | "GitHub PR"
    | "GitHub Issue"
    | "Release"
    | "Discord"
    | "Cursor"
    | "Unknown" => {
    if (!documentId) return "Unknown";
    if (documentId.includes("/pull-requests/")) return "GitHub PR";
    if (documentId.includes("/issues/")) return "GitHub Issue";
    if (documentId.includes("/releases/")) return "Release";
    if (documentId.startsWith("discord/")) return "Discord";
    if (documentId.startsWith("cursor/")) return "Cursor";
    return "Unknown";
  };

  const getSourceLabelFromType = (
    sourceType: string,
    documentId: string | null | undefined
  ): string => {
    if (!documentId) return sourceType;
    if (sourceType === "GitHub PR") {
      const match = documentId.match(/\/pull-requests\/(\d+)\//);
      return match ? `PR #${match[1]}` : "GitHub PR";
    }
    if (sourceType === "GitHub Issue") {
      const match = documentId.match(/\/issues\/(\d+)\//);
      return match ? `Issue #${match[1]}` : "GitHub Issue";
    }
    if (sourceType === "Release") {
      const match = documentId.match(/\/releases\/([^/]+)\//);
      return match ? `Release ${match[1]}` : "Release";
    }
    return sourceType;
  };

  const getUrlFromDocumentId = (
    documentId: string | null | undefined,
    repo: string
  ): string | null => {
    if (!documentId) return null;
    const [owner, repoName] = repo.split("/");
    if (documentId.includes("/pull-requests/")) {
      const match = documentId.match(/\/pull-requests\/(\d+)\//);
      if (match) {
        return `https://github.com/${owner}/${repoName}/pull/${match[1]}`;
      }
    }
    if (documentId.includes("/issues/")) {
      const match = documentId.match(/\/issues\/(\d+)\//);
      if (match) {
        return `https://github.com/${owner}/${repoName}/issues/${match[1]}`;
      }
    }
    if (documentId.includes("/releases/")) {
      const match = documentId.match(/\/releases\/([^/]+)\//);
      if (match) {
        return `https://github.com/${owner}/${repoName}/releases/tag/${match[1]}`;
      }
    }
    return null;
  };

  const SourceIcon = ({
    type,
  }: {
    type:
      | "GitHub PR"
      | "GitHub Issue"
      | "Release"
      | "Discord"
      | "Cursor"
      | "Unknown";
  }) => {
    const className = "w-3 h-3";
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

  const transformToTimelineEvents = (
    developmentStream: Array<{
      id: string;
      title: string;
      summary: string;
      createdAt: string | null;
      documentId: string | null;
      importance?: number | null;
    }>,
    repo: string
  ) => {
    return developmentStream.map((moment) => {
      const sourceType = getSourceTypeFromDocumentId(moment.documentId);
      const sourceLabel = getSourceLabelFromType(sourceType, moment.documentId);
      const url = getUrlFromDocumentId(moment.documentId, repo);

      return {
        id: moment.id,
        title: moment.title || "Untitled",
        summary: moment.summary,
        createdAt: moment.createdAt,
        documentId: moment.documentId,
        sourceType,
        source: sourceLabel,
        url,
        event: moment.title || "Untitled",
        impact: moment.summary || "No specific impact noted.",
      };
    });
  };

  const transformToDecisions = (
    developmentStream: Array<{
      id: string;
      title: string;
      summary: string;
      createdAt: string | null;
      documentId: string | null;
      importance?: number | null;
    }>,
    repo: string
  ): Decision[] => {
    return developmentStream
      .filter((moment) => {
        // Only include moments with both title and summary
        return moment.title && moment.summary;
      })
      .map((moment) => {
        const sourceType = getSourceTypeFromDocumentId(moment.documentId);
        const sourceLabel = getSourceLabelFromType(
          sourceType,
          moment.documentId
        );
        const formattedDate = formatDateShort(moment.createdAt);
        const trigger = `${sourceLabel} (${formattedDate})`;

        return {
          id: moment.id,
          problem: moment.title || "Untitled",
          trigger,
          result: moment.summary || "No specific change noted.",
        };
      });
  };

  return (
    <div className="space-y-6">
      {/* Evolution Section */}
      <div className="mb-12 overflow-hidden border border-slate-200 rounded-xl bg-white shadow-sm">
        <div className="bg-slate-50 border-b border-slate-200 px-6 py-4">
          <h3 className="text-xs font-bold text-slate-700 uppercase tracking-widest relative inline-block">
            Evolution of the code across pull requests
            <div className="absolute -bottom-1 left-0 w-full h-1 bg-blue-500/30 rounded-full"></div>
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-white border-b border-slate-100">
                <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
                  Date
                </th>
                <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
                  Source
                </th>
                <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
                  Event
                </th>
                <th className="px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">
                  Impact on{" "}
                  <code className="mono normal-case text-indigo-500 bg-indigo-50/50 px-1 rounded">
                    {file.split("/").pop()}
                  </code>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {timelineResult.developmentStream &&
              timelineResult.developmentStream.length > 0 ? (
                timelineResult.developmentStream.map((moment, idx) => {
                  const sourceType = getSourceTypeFromDocumentId(
                    moment.documentId
                  );
                  const url = getUrlFromDocumentId(moment.documentId, repo);
                  const date = formatDateShort(moment.createdAt);
                  const event = moment.title || "Untitled";
                  const impact = moment.summary || "No specific impact noted.";

                  const BadgeContent = (
                    <div
                      className={`inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 rounded border mono uppercase transition-all ${
                        sourceType === "GitHub PR"
                          ? "text-purple-600 bg-purple-50 border-purple-100"
                          : sourceType === "GitHub Issue"
                          ? "text-emerald-600 bg-emerald-50 border-emerald-100"
                          : sourceType === "Cursor"
                          ? "text-sky-600 bg-sky-50 border-sky-100"
                          : sourceType === "Release"
                          ? "text-slate-600 bg-slate-50 border-slate-200 shadow-sm"
                          : "text-slate-600 bg-slate-50 border-slate-200"
                      } ${
                        url
                          ? "hover:scale-105 hover:shadow-sm active:scale-95"
                          : ""
                      }`}
                    >
                      <SourceIcon type={sourceType} />
                      {getSourceLabelFromType(sourceType, moment.documentId)}
                    </div>
                  );

                  return (
                    <tr
                      key={moment.id || idx}
                      className="hover:bg-slate-50/50 transition-colors"
                    >
                      <td className="px-6 py-4 text-[11px] font-bold text-slate-900 mono whitespace-nowrap">
                        {date}
                      </td>
                      <td className="px-6 py-4">
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="View Source"
                          >
                            {BadgeContent}
                          </a>
                        ) : (
                          BadgeContent
                        )}
                      </td>
                      <td className="px-6 py-4 text-xs font-medium text-slate-800 leading-tight max-w-xs">
                        {event}
                      </td>
                      <td className="px-6 py-4 text-[11px] text-slate-600 leading-snug">
                        {impact}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan={4}
                    className="px-6 py-8 text-center text-sm text-slate-500"
                  >
                    No evolution events found in the timeline.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Key Decisions Grid Section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Decision Matrix</CardTitle>
          <CardDescription>
            Tracing architectural shifts from problem to implementation
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DecisionGrid
            decisions={transformToDecisions(
              timelineResult.developmentStream || [],
              repo
            )}
          />
        </CardContent>
      </Card>

      {/* Development Stream Section */}
      <Card className="border-l-4 border-l-orange-500">
        <CardHeader>
          <CardTitle className="text-2xl">Development Stream</CardTitle>
          <CardDescription>
            Chronological timeline of events that influenced this code
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TimelineSection
            events={transformToTimelineEvents(
              timelineResult.developmentStream || [],
              repo
            )}
            fileName={file.split("/").pop() || file}
          />
        </CardContent>
      </Card>
    </div>
  );
}

async function TldrContent({
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
  const result = await generateCodeTldr({
    repo,
    commit,
    file,
    line,
    namespace: namespace || undefined,
  });

  if (!result.success) {
    return (
      <Card className="border-red-500">
        <CardHeader>
          <CardTitle className="text-red-600">Error</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-600">{result.error}</p>
          {result.details && (
            <p className="text-sm text-gray-600 mt-2">{result.details}</p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-l-4 border-l-blue-500">
      <CardHeader>
        <CardTitle className="text-2xl">TL;DR</CardTitle>
        <CardDescription>
          Quick summary of how this code evolved and why it exists
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="prose max-w-none">
          <p className="text-lg leading-relaxed whitespace-pre-wrap text-gray-700">
            {result.tldr}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
