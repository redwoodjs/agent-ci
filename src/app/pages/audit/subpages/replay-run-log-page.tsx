import { env } from "cloudflare:workers";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card";
import {
  getReplayRunById,
  getReplayRunEvents,
} from "@/app/engine/databases/indexingState/momentReplay";
import { ReplayRunLogText } from "./replay-run-log-text";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizePayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

function formatEventsAsText(
  events: Array<{ createdAt: string; level: string; kind: string; payload: any }>
): string {
  const chronological = [...events].reverse();
  const lines: string[] = [];
  for (const e of chronological) {
    const payload = normalizePayload(e.payload);
    const payloadOneLine = (() => {
      try {
        return JSON.stringify(payload);
      } catch {
        return String(payload);
      }
    })();
    lines.push(`${e.createdAt} [${e.level}] ${e.kind} ${payloadOneLine}`);
  }
  return lines.join("\n");
}

export async function ReplayRunLogPage({ request }: { request: Request }) {
  const url = new URL(request.url);
  const runIdRaw = url.searchParams.get("runId");
  const runId = typeof runIdRaw === "string" && runIdRaw.trim().length > 0
    ? runIdRaw.trim()
    : null;

  const limitRaw = url.searchParams.get("limit");
  const limit =
    typeof limitRaw === "string" && limitRaw.trim().length > 0
      ? Math.max(1, Math.min(5000, Math.floor(Number(limitRaw))))
      : 500;

  if (!runId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Replay run log</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-gray-700">Missing runId.</div>
        </CardContent>
      </Card>
    );
  }

  const envCloudflare = env as Cloudflare.Env;

  const run = await getReplayRunById(
    { env: envCloudflare, momentGraphNamespace: null },
    { runId }
  );

  const events = await getReplayRunEvents(
    { env: envCloudflare, momentGraphNamespace: null },
    { runId, limit }
  );

  const header = {
    runId,
    status: run?.status ?? null,
    startedAt: run?.startedAt ?? null,
    updatedAt: run?.updatedAt ?? null,
    expectedDocuments: run?.expectedDocuments ?? null,
    processedDocuments: run?.processedDocuments ?? null,
    succeededDocuments: run?.succeededDocuments ?? null,
    failedDocuments: run?.failedDocuments ?? null,
    replayedItems: run?.replayedItems ?? null,
    totalItems: run?.totalItems ?? null,
    pendingItems: run?.pendingItems ?? null,
    doneItems: run?.doneItems ?? null,
    failedItems: run?.failedItems ?? null,
    replayEnqueued: run?.replayEnqueued ?? null,
    replayOrder: run?.replayOrder ?? null,
    lastProgressAt: run?.lastProgressAt ?? null,
    lastItemId: run?.lastItemId ?? null,
    lastItemOrderMs: run?.lastItemOrderMs ?? null,
    lastItemDocumentId: run?.lastItemDocumentId ?? null,
    lastItemEffectiveNamespace: run?.lastItemEffectiveNamespace ?? null,
    consecutiveFailures: run?.consecutiveFailures ?? null,
    lastError: normalizePayload(run?.lastError ?? null),
  };

  const text =
    `Replay run: ${runId}\n` +
    `Event limit: ${limit}\n\n` +
    `Run snapshot:\n${safeStringify(header)}\n\n` +
    `Events:\n${formatEventsAsText(events)}\n`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Replay run log</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-xs text-gray-600">
            Pass <span className="font-mono">runId</span> and optional{" "}
            <span className="font-mono">limit</span> query params.
          </div>
          <div className="text-xs text-gray-600 mt-1">
            This page renders events as plain text so it can be copy/pasted.
          </div>
        </CardContent>
      </Card>

      <ReplayRunLogText text={text} />
    </div>
  );
}

