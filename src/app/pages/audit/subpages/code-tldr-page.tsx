import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { generateCodeTldr } from "./actions";

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
            <p className="text-lg leading-relaxed whitespace-pre-wrap text-gray-700 break-words">
              {result.tldr}
            </p>
          </div>
        </CardContent>
      </Card>

      {result.narrative && (
        <Card className="border-l-4 border-l-indigo-500">
          <CardHeader>
            <CardTitle className="text-2xl">Overarching Narrative</CardTitle>
            <CardDescription>
              The overarching narrative of how this code came to exist in its
              current form
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="prose max-w-none">
              <p className="text-base leading-relaxed whitespace-pre-wrap text-gray-700 break-words">
                {result.narrative}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
