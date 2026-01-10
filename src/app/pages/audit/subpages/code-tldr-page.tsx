import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { generateCodeTldr, fetchCodeTimeline } from "./actions";

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
        <EvolutionSection repo={repo} commit={commit} namespace={namespace} />
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
    <div className="space-y-6">
      <Card className="border-l-4 border-l-blue-500">
        <CardHeader>
          <CardTitle className="text-2xl">TL;DR</CardTitle>
          <CardDescription>
            Quick summary of how this code evolved and why it exists
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="prose max-w-none">
            <p className="text-lg leading-relaxed whitespace-pre-wrap text-gray-700 wrap-break-word">
              {result.tldr}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

async function EvolutionSection({
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
      <Card className="border-l-4 border-l-green-500">
        <CardHeader>
          <CardTitle className="text-2xl">Evolution</CardTitle>
          <CardDescription>
            Detailed narrative of how this code evolved over time
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600">No evolution data available.</p>
        </CardContent>
      </Card>
    );
  }

  // Generate a narrative from the timeline
  const narrative = sortedTimeline
    .map((moment: any, idx: number) => {
      const date = moment.createdAt
        ? new Date(moment.createdAt).toLocaleDateString()
        : "Unknown date";
      return `${idx + 1}. [${date}] ${moment.title}: ${moment.summary}`;
    })
    .join("\n\n");

  return (
    <Card className="border-l-4 border-l-green-500">
      <CardHeader>
        <CardTitle className="text-2xl">Evolution</CardTitle>
        <CardDescription>
          Detailed narrative of how this code evolved over time
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="prose max-w-none">
          <div className="text-base leading-relaxed whitespace-pre-wrap text-gray-700 wrap-break-word">
            {narrative}
          </div>
        </div>
      </CardContent>
    </Card>
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
