import { env } from "cloudflare:workers";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/app/components/ui/card";
import { IngestionFileContent } from "./ingestion-file-content";
import { ViewInGraphButton } from "./view-in-graph-button";
import { parseThreadFromJson } from "@/app/ingestors/discord/utils/thread-to-json";
import type { components } from "@/app/ingestors/discord/discord-api-types";
import {
  applyMomentGraphNamespacePrefixValue,
  getMomentGraphNamespaceFromEnv,
  getMomentGraphNamespacePrefixFromEnv,
} from "@/app/engine/momentGraphNamespace";
import {
  getDocumentAuditLogsForDocument,
  getMomentsForDocument,
  type MomentGraphContext,
} from "@/app/engine/databases/momentGraph";

type DiscordMessage = components["schemas"]["MessageResponse"];

type IngestionFilePageProps = {
  request: Request;
  params: {
    $0: string;
  };
};

function isDiscordFile(key: string): boolean {
  return key.startsWith("discord/");
}

async function parseDiscordContent(
  content: string,
  key: string
): Promise<DiscordMessage[] | null> {
  // Try parsing as JSON (thread page format)
  try {
    const threadData = await parseThreadFromJson(content);
    if (threadData) {
      // Combine starter message and messages
      return [threadData.starterMessage, ...threadData.messages];
    }
  } catch {
    // Not a thread JSON, continue to try JSONL
  }

  // Try parsing as JSONL (daily channel logs)
  try {
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const messages: DiscordMessage[] = [];

    for (const line of lines) {
      try {
        const message = JSON.parse(line) as DiscordMessage;
        // Basic validation - check if it has required Discord message fields
        if (
          message.id &&
          message.timestamp &&
          message.author &&
          typeof message.content === "string"
        ) {
          messages.push(message);
        }
      } catch {
        // Skip invalid JSON lines (might be truncated or malformed)
        continue;
      }
    }

    if (messages.length > 0) {
      return messages;
    }
  } catch {
    // Failed to parse as JSONL
  }

  return null;
}

export async function IngestionFilePage({
  params,
  request,
}: IngestionFilePageProps) {
  const key = decodeURIComponent(params.$0);
  const bucket = env.MACHINEN_BUCKET;

  const url = new URL(request.url);
  const namespaceParam = url.searchParams.get("namespace") || null;
  const namespace = namespaceParam === "all" ? null : namespaceParam;
  const prefixParam = url.searchParams.get("prefix") || null;
  const prefix =
    prefixParam && prefixParam.trim().length > 0 ? prefixParam : null;
  const backLinkParams = new URLSearchParams();
  if (namespaceParam) {
    backLinkParams.set("namespace", namespaceParam);
  }
  if (prefixParam) {
    backLinkParams.set("prefix", prefixParam);
  }

  const envCloudflare = env as Cloudflare.Env;
  const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
  const prefixOverride =
    typeof prefix === "string" && prefix.trim().length > 0
      ? prefix.trim()
      : null;
  const effectivePrefix = prefixOverride ?? envPrefix;
  const envNamespace = getMomentGraphNamespaceFromEnv(envCloudflare);
  const baseNamespace = namespace ?? envNamespace;

  const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
    baseNamespace,
    effectivePrefix
  );

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
  const isDiscord = isDiscordFile(key);

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

  // Try to parse Discord messages if this is a Discord file
  let messages: DiscordMessage[] | null = null;
  if (isDiscord) {
    messages = await parseDiscordContent(content, key);
  }

  const momentGraphContext: MomentGraphContext = {
    env: envCloudflare,
    momentGraphNamespace: effectiveNamespace,
  };
  const moments = await getMomentsForDocument(key, momentGraphContext, {
    limit: 5000,
    offset: 0,
  });
  const documentAudit = await getDocumentAuditLogsForDocument(
    key,
    momentGraphContext,
    {
      kindPrefix: "synthesis:",
      limit: 50,
    }
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-4">
      <div>
        <a
          href={`/audit/ingestion?${backLinkParams.toString()}`}
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
            {effectiveNamespace && (
              <span>
                <span className="font-medium text-gray-700">Namespace:</span>{" "}
                <span className="font-mono bg-gray-100 px-1 rounded">
                  {effectiveNamespace}
                </span>
              </span>
            )}
            {truncated && (
              <span className="text-orange-700">
                Showing first ~{formatBytes(MAX_BYTES_TO_SHOW)} of file
              </span>
            )}
            {isDiscord && messages && (
              <span className="text-green-700">
                {messages.length} message{messages.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          <IngestionFileContent
            rawContent={content}
            messages={messages}
            isDiscord={isDiscord}
            truncated={truncated}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Moments ({moments.length})</CardTitle>
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
                  <div className="mt-2">
                    <ViewInGraphButton
                      momentId={moment.id}
                      namespace={namespace}
                      prefix={prefix}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            Synthesis audit ({documentAudit.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {documentAudit.length === 0 ? (
            <p className="text-gray-600 text-sm">
              No synthesis audit records found for this document.
            </p>
          ) : (
            <div className="space-y-2">
              {documentAudit.map((e) => {
                const message =
                  typeof e?.payload?.message === "string"
                    ? e.payload.message
                    : null;
                const timelineFitError =
                  typeof (e as any)?.payload?.timelineFitError === "string"
                    ? ((e as any).payload.timelineFitError as string)
                    : null;
                return (
                  <div key={e.id} className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">
                      <span className="font-mono">{e.kind}</span>{" "}
                      <span className="text-gray-400">{e.createdAt}</span>
                    </div>
                    {message && (
                      <div className="text-xs text-gray-700 mt-1">
                        {message}
                      </div>
                    )}
                    {timelineFitError && (
                      <div className="text-xs text-red-700 mt-1">
                        Timeline fit error:{" "}
                        <span className="font-mono">{timelineFitError}</span>
                      </div>
                    )}
                    <details className="mt-2">
                      <summary className="text-xs font-medium text-gray-700 cursor-pointer">
                        Payload
                      </summary>
                      <pre className="text-xs overflow-auto max-h-64 mt-2 p-2 bg-white border rounded">
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    </details>
                  </div>
                );
              })}
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
