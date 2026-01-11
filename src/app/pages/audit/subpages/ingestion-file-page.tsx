import { env } from "cloudflare:workers";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/app/components/ui/card";
import { getMomentsForDocument } from "@/app/engine/momentDb";
import { getMomentGraphNamespaceFromEnv } from "@/app/engine/momentGraphNamespace";

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

  const moments = await getMomentsForDocument(key, {
    env: env as Cloudflare.Env,
    momentGraphNamespace: getMomentGraphNamespaceFromEnv(env),
  });

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

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Moments ({moments.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {moments.length === 0 ? (
            <p className="text-gray-600 text-sm">
              No moments found for this document.
            </p>
          ) : (
            <div className="space-y-4">
              {moments.map((moment) => (
                <div key={moment.id} className="border p-3 rounded-md">
                  <div className="flex justify-between items-start gap-4">
                    <div>
                      <h4 className="font-medium text-sm">{moment.title}</h4>
                      <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap">
                        {moment.summary}
                      </p>
                    </div>
                    <div className="text-right text-xs text-gray-400 shrink-0">
                      <div>{new Date(moment.createdAt).toLocaleString()}</div>
                      <div className="font-mono mt-1" title={moment.id}>
                        {moment.id.substring(0, 8)}...
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs flex gap-2 flex-wrap">
                    {moment.isSubject && (
                      <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                        Subject
                      </span>
                    )}
                    {moment.parentId && (
                      <span className="bg-gray-100 text-gray-800 px-2 py-0.5 rounded">
                        Parent: {moment.parentId.substring(0, 8)}...
                      </span>
                    )}
                    <span className="bg-gray-50 text-gray-600 px-2 py-0.5 rounded">
                      Imp: {moment.importance?.toFixed(2) ?? "N/A"}
                    </span>
                    {moment.momentKind && (
                      <span className="bg-purple-50 text-purple-700 px-2 py-0.5 rounded">
                        {moment.momentKind}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
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


