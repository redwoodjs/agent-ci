import { env } from "cloudflare:workers";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/app/components/ui/card";

type IngestionFilePageProps = {
  params: {
    $0: string;
  };
};

export async function IngestionFilePage({ params }: IngestionFilePageProps) {
  const key = decodeURIComponent(params.$0);
  const bucket = env.MACHINEN_BUCKET;

  const object = await bucket.get(key);

  if (!object) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-3xl font-bold mb-4">File not found</h1>
        <p className="text-gray-600">
          No object was found in the ingestion bucket with key{" "}
          <span className="font-mono break-all">{key}</span>.
        </p>
      </div>
    );
  }

  const size = object.size;

  // For very large objects, only show a prefix so the UI stays responsive.
  const MAX_BYTES_TO_SHOW = 200_000; // ~200KB
  let content: string;
  let truncated = false;

  if (size > MAX_BYTES_TO_SHOW) {
    const stream = object.body;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (received < MAX_BYTES_TO_SHOW) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = MAX_BYTES_TO_SHOW - received;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        received += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }

    const combined = new Uint8Array(
      chunks.reduce((sum, c) => sum + c.byteLength, 0)
    );
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    content = new TextDecoder("utf-8", { fatal: false }).decode(combined);
    truncated = true;
  } else {
    // For smaller objects, just read as text directly.
    content = await object.text();
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-4">
      <div>
        <a
          href="/audit/ingestion"
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          ← Back to ingestion files
        </a>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            File: <span className="font-mono text-sm break-all">{key}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 text-sm text-gray-600 space-x-4">
            <span>
              <span className="font-medium text-gray-700">Size:</span>{" "}
              {formatBytes(size)}
            </span>
            {truncated && (
              <span className="text-orange-700">
                Showing first ~{formatBytes(MAX_BYTES_TO_SHOW)} of file
              </span>
            )}
          </div>

          <div className="border rounded-md bg-black text-gray-100 text-sm overflow-auto max-h-[70vh]">
            <pre className="p-4 whitespace-pre-wrap break-words font-mono text-xs">
              {content}
              {truncated && "\n\n---\n(truncated) ---"}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(2)} ${sizes[i]}`;
}


