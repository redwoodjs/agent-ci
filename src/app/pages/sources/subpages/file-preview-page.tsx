import { env } from "cloudflare:workers";

export async function FilePreviewPage({
  params,
}: {
  params: { sourceID: string; $0: string };
}) {
  const filePath = params.$0;

  if (!filePath) {
    return <div>File path is required</div>;
  }

  const file = await env.MACHINEN_BUCKET.get(filePath);

  if (!file) {
    return <div>File not found</div>;
  }

  const content = await file.text();
  const contentType = file.httpMetadata?.contentType || "text/plain";

  const isJSON = contentType.includes("json") || filePath.endsWith(".json");
  const isMarkdown = filePath.endsWith(".md");

  let displayContent = content;
  if (isJSON) {
    try {
      displayContent = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      displayContent = content;
    }
  }

  return (
    <div className="flex-1 p-6 bg-white w-full">
      <div className="max-w-7xl mx-auto w-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-black mb-2">File Preview</h1>
          <p className="text-sm text-muted-foreground font-mono">{filePath}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {formatBytes(file.size)} • {contentType}
          </p>
        </div>

        <div className="border rounded-lg bg-gray-50 p-4 overflow-auto">
          <pre className="text-sm whitespace-pre font-mono">
            {displayContent}
          </pre>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

