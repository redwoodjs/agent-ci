import { env } from "cloudflare:workers";
import { Suspense } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import {
  getRecentSimulationRuns,
  getSimulationRunById,
  getSimulationRunEvents,
  getSimulationRunDocuments,
  getSimulationRunMicroBatches,
  getSimulationRunMacroOutputs,
  getSimulationRunLinkDecisions,
  simulationPhases,
} from "@/app/engine/simulationDb";
import { SimulationRunControls } from "./simulation-run-controls";

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

export function SimulationRunsPage({ request }: { request: Request }) {
  const url = new URL(request.url);
  const runIdRaw = url.searchParams.get("runId");
  const runId =
    typeof runIdRaw === "string" && runIdRaw.trim().length > 0
      ? runIdRaw.trim()
      : null;
  const viewRaw = url.searchParams.get("view");
  const view =
    viewRaw === "documents" ||
    viewRaw === "micro-batches" ||
    viewRaw === "macro-outputs" ||
    viewRaw === "materialized-moments" ||
    viewRaw === "link-decisions"
      ? viewRaw
      : null;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-2">Simulation runs</h1>
      <div className="text-sm text-gray-600 mb-6">
        Run state and run-scoped events stored in the simulation DB.
      </div>

      <Suspense fallback={<PageSkeleton />}>
        <SimulationRunsContent runId={runId} view={view} />
      </Suspense>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Loading</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-gray-600">Fetching simulation runs…</div>
        </CardContent>
      </Card>
    </div>
  );
}

async function SimulationRunsContent({
  runId,
  view,
}: {
  runId: string | null;
  view:
    | "documents"
    | "micro-batches"
    | "macro-outputs"
    | "materialized-moments"
    | "link-decisions"
    | null;
}) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };

  const runs = await getRecentSimulationRuns(context, { limit: 50 });

  if (!runId) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Start a run</CardTitle>
            <CardDescription>
              Start a run from the UI, then use Advance to execute phases.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SimulationRunControls mode="start" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent runs</CardTitle>
            <CardDescription>Most recent first</CardDescription>
          </CardHeader>
          <CardContent>
            {runs.length === 0 ? (
              <div className="text-sm text-gray-600">No runs yet.</div>
            ) : (
              <div className="space-y-2">
                {runs.map((r) => (
                  <div
                    key={r.runId}
                    className="flex items-start justify-between gap-4 p-2 rounded hover:bg-gray-50"
                  >
                    <div>
                      <div className="font-mono text-sm">{r.runId}</div>
                      <div className="text-xs text-gray-600 mt-1">
                        status={r.status} phase={String(r.currentPhase)} updated=
                        {r.updatedAt}
                      </div>
                    </div>
                    <a
                      className="text-sm text-blue-600 hover:underline"
                      href={`/audit/simulation?runId=${encodeURIComponent(
                        r.runId
                      )}`}
                    >
                      View
                    </a>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const [run, eventsRes] = await Promise.all([
    getSimulationRunById(context, { runId }),
    getSimulationRunEvents(context, { runId, limit: 2000 }),
  ]);

  if (!run) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Run not found</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-gray-700">
            No run found for <span className="font-mono">{runId}</span>
          </div>
          <div className="mt-3">
            <a className="text-sm text-blue-600 hover:underline" href="/audit/simulation">
              Back to list
            </a>
          </div>
        </CardContent>
      </Card>
    );
  }

  const eventsText = formatEventsAsText(eventsRes);

  const documentsLink = `/audit/simulation?runId=${encodeURIComponent(
    runId
  )}&view=documents`;
  const microBatchesLink = `/audit/simulation?runId=${encodeURIComponent(
    runId
  )}&view=micro-batches`;
  const macroOutputsLink = `/audit/simulation?runId=${encodeURIComponent(
    runId
  )}&view=macro-outputs`;
  const materializedLink = `/audit/simulation?runId=${encodeURIComponent(
    runId
  )}&view=materialized-moments`;
  const linkDecisionsLink = `/audit/simulation?runId=${encodeURIComponent(
    runId
  )}&view=link-decisions`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Run</CardTitle>
          <CardDescription className="font-mono text-xs">{runId}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm">
            <div>
              status=<span className="font-mono">{run.status}</span>
            </div>
            <div>
              phase=<span className="font-mono">{String(run.currentPhase)}</span>
            </div>
            <div>
              updated=<span className="font-mono">{run.updatedAt}</span>
            </div>
          </div>

          <SimulationRunControls
            mode="run"
            runId={runId}
            currentPhase={String(run.currentPhase)}
            status={String(run.status)}
            phases={[...simulationPhases]}
          />

          <div className="flex gap-2 flex-wrap">
            <a className="text-sm text-blue-600 hover:underline" href={documentsLink}>
              Documents
            </a>
            <a
              className="text-sm text-blue-600 hover:underline"
              href={microBatchesLink}
            >
              Micro batches
            </a>
            <a
              className="text-sm text-blue-600 hover:underline"
              href={macroOutputsLink}
            >
              Macro outputs
            </a>
            <a
              className="text-sm text-blue-600 hover:underline"
              href={materializedLink}
            >
              Materialized moments
            </a>
            <a
              className="text-sm text-blue-600 hover:underline"
              href={linkDecisionsLink}
            >
              Link decisions
            </a>
          </div>
        </CardContent>
      </Card>

      {view === "documents" ? (
        <DocumentsCard runId={runId} />
      ) : view === "micro-batches" ? (
        <MicroBatchesCard runId={runId} />
      ) : view === "macro-outputs" ? (
        <MacroOutputsCard runId={runId} />
      ) : view === "materialized-moments" ? (
        <MaterializedMomentsCard runId={runId} />
      ) : view === "link-decisions" ? (
        <LinkDecisionsCard runId={runId} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Events</CardTitle>
          <CardDescription>
            Copy/paste friendly view of persisted run events
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-gray-50 border rounded p-3 overflow-auto max-h-[60vh]">
            {eventsText || "(no events)"}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Run snapshot</CardTitle>
          <CardDescription>Raw run fields</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-gray-50 border rounded p-3 overflow-auto max-h-[40vh]">
            {safeStringify(run)}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

async function DocumentsCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const docs = await getSimulationRunDocuments(context, { runId });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Documents</CardTitle>
        <CardDescription>Per-run diff results</CardDescription>
      </CardHeader>
      <CardContent>
        {docs.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => (
              <div
                key={d.r2Key}
                className="flex items-start justify-between gap-4 p-2 rounded border bg-white"
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs break-all">{d.r2Key}</div>
                  <div className="text-xs text-gray-600 mt-1">
                    changed={String(d.changed)} etag={d.etag ?? "null"}
                  </div>
                  {d.error ? (
                    <div className="text-xs text-red-700 mt-1">
                      {safeStringify(d.error)}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function MicroBatchesCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const batches = await getSimulationRunMicroBatches(context, { runId });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Micro batches</CardTitle>
        <CardDescription>Per-run micro batch mapping</CardDescription>
      </CardHeader>
      <CardContent>
        {batches.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {batches.slice(0, 200).map((b) => (
              <div
                key={`${b.r2Key}:${b.batchIndex}`}
                className="flex items-start justify-between gap-4 p-2 rounded border bg-white"
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs break-all">{b.r2Key}</div>
                  <div className="text-xs text-gray-600 mt-1">
                    idx={String(b.batchIndex)} status={b.status} hash=
                    {b.batchHash.slice(0, 10)}…
                  </div>
                  {b.error ? (
                    <div className="text-xs text-red-700 mt-1">
                      {safeStringify(b.error)}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {batches.length > 200 ? (
              <div className="text-xs text-gray-600">
                Showing first 200 of {batches.length}
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function MacroOutputsCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const outputs = await getSimulationRunMacroOutputs(context, { runId });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Macro outputs</CardTitle>
        <CardDescription>
          Per-run macro synthesis outputs (streams + macro moments)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {outputs.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {outputs.map((o) => (
              <div key={o.r2Key} className="rounded border bg-white">
                <div className="p-2">
                  <div className="font-mono text-xs break-all">{o.r2Key}</div>
                  <div className="text-xs text-gray-600 mt-1">
                    stream_hash={o.microStreamHash.slice(0, 10)}… use_llm=
                    {String(o.useLlm)}
                  </div>
                </div>
                <pre className="text-xs bg-gray-50 border-t p-2 overflow-auto max-h-[40vh]">
                  {safeStringify({
                    gating: o.gating,
                    anchors: o.anchors,
                    streams: o.streams,
                    audit: o.audit,
                  })}
                </pre>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function MaterializedMomentsCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const baseUrl = process.env.MACHINEN_BASE_URL ?? "http://localhost:5173";
  const apiKey = process.env.MACHINEN_API_KEY ?? "";
  const headers =
    apiKey.trim().length > 0 ? { Authorization: `Bearer ${apiKey}` } : {};

  const res = await fetch(
    `${baseUrl}/admin/simulation/run/${encodeURIComponent(
      runId
    )}/materialized-moments`,
    { headers }
  );
  const text = await res.text();
  const parsed = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const moments = Array.isArray(parsed?.moments) ? parsed.moments : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Materialized moments</CardTitle>
        <CardDescription>Per-run moment ids written into the moment graph</CardDescription>
      </CardHeader>
      <CardContent>
        {moments.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {moments.slice(0, 200).map((m: any) => (
              <div key={m.momentId} className="p-2 rounded border bg-white">
                <div className="font-mono text-xs break-all">{m.momentId}</div>
                <div className="text-xs text-gray-600 mt-1">
                  r2Key={m.r2Key} stream={m.streamId} idx={String(m.macroIndex)} parent=
                  {m.parentId ?? "null"}
                </div>
              </div>
            ))}
            {moments.length > 200 ? (
              <div className="text-xs text-gray-600">
                Showing first 200 of {moments.length}
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function LinkDecisionsCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const decisions = await getSimulationRunLinkDecisions(context, { runId });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Link decisions</CardTitle>
        <CardDescription>Per-run deterministic_linking decisions</CardDescription>
      </CardHeader>
      <CardContent>
        {decisions.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {decisions.slice(0, 200).map((d: any) => (
              <div
                key={d.childMomentId}
                className="p-2 rounded border bg-white"
              >
                <div className="font-mono text-xs break-all">
                  {d.childMomentId}
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  r2Key={d.r2Key} stream={d.streamId} idx={String(d.macroIndex)} outcome=
                  {d.outcome} parent={d.parentMomentId ?? "null"} rule=
                  {d.ruleId ?? "null"}
                </div>
                {d.evidence ? (
                  <pre className="text-xs bg-gray-50 border rounded p-2 mt-2 overflow-auto max-h-[30vh]">
                    {safeStringify(d.evidence)}
                  </pre>
                ) : null}
              </div>
            ))}
            {decisions.length > 200 ? (
              <div className="text-xs text-gray-600">
                Showing first 200 of {decisions.length}
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
