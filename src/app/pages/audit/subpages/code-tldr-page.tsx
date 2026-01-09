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
            </ul>
            <div className="mt-4 p-4 bg-gray-50 rounded">
              <p className="text-sm font-mono">
                Example URL:
                <br />
                /audit/tldr?repo=owner/repo&commit=abc123&file=src/app/file.ts:42
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
        <CodeTldrContent repo={repo} commit={commit} file={file} line={line} />
      </Suspense>
    </div>
  );
}

async function CodeTldrContent({
  repo,
  commit,
  file,
  line,
}: {
  repo: string;
  commit: string;
  file: string;
  line: number;
}) {
  const result = await generateCodeTldr({
    repo,
    commit,
    file,
    line,
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
    <Card>
      <CardHeader>
        <CardTitle>TL;DR</CardTitle>
        <CardDescription>
          Summary of how this code evolved and why it exists
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="prose max-w-none">
          <p className="text-lg leading-relaxed whitespace-pre-wrap">
            {result.tldr}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
