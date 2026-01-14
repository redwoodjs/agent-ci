import { env } from "cloudflare:workers";
import { Suspense } from "react";
import { applyMomentGraphNamespacePrefixValue } from "@/app/engine/momentGraphNamespace";
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
  getSimulationRunCandidateSets,
  getSimulationRunTimelineFitDecisions,
  simulationPhases,
} from "@/app/engine/databases/simulationState";
import { getSimulationRunProgressSummary } from "@/app/engine/adapters/simulation/runProgress";
import { SimulationRunControls } from "./simulation-run-controls";
import { CopyTextButton } from "./copy-text-button";

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
  events: Array<{
    createdAt: string;
    level: string;
    kind: string;
    payload: any;
  }>
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

function findLatestPhaseEndPayload(
  events: Array<{
    createdAt: string;
    level: string;
    kind: string;
    payload: any;
  }>,
  phase: string
): any | null {
  for (const e of events) {
    if (e.kind !== "phase.end") {
      continue;
    }
    const payload = normalizePayload(e.payload) as any;
    if (
      payload &&
      typeof payload === "object" &&
      String(payload.phase ?? "") === phase
    ) {
      return payload;
    }
  }
  return null;
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
    viewRaw === "link-decisions" ||
    viewRaw === "candidate-sets" ||
    viewRaw === "timeline-fit-decisions"
      ? viewRaw
      : null;
  const logViewRaw = url.searchParams.get("logView");
  const logView = logViewRaw === "run" ? "run" : "events";

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-2">Simulation runs</h1>
      <div className="text-sm text-gray-600 mb-6">
        Run state and run-scoped events stored in the simulation DB.
      </div>

      <Suspense fallback={<PageSkeleton />}>
        <SimulationRunsContent runId={runId} view={view} logView={logView} />
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
  logView,
}: {
  runId: string | null;
  view:
    | "documents"
    | "micro-batches"
    | "macro-outputs"
    | "materialized-moments"
    | "link-decisions"
    | "candidate-sets"
    | "timeline-fit-decisions"
    | null;
  logView: "events" | "run";
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
              Start a run from the UI, then use Run to execute phases.
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
                      <div className="font-mono text-sm">
                        {r.momentGraphNamespacePrefix ?? "(no prefix)"}
                      </div>
                      <div className="text-xs text-gray-600 mt-1 font-mono">
                        runId={r.runId}
                      </div>
                      <div className="text-xs text-gray-600 mt-1">
                        status={r.status} phase={String(r.currentPhase)}{" "}
                        updated=
                        {r.updatedAt}
                      </div>
                      <div className="text-xs text-gray-600 mt-1 font-mono">
                        ns={r.momentGraphNamespace ?? "null"} prefix=
                        {r.momentGraphNamespacePrefix ?? "null"}
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
            <a
              className="text-sm text-blue-600 hover:underline"
              href="/audit/simulation"
            >
              Back to list
            </a>
          </div>
        </CardContent>
      </Card>
    );
  }

  const eventsText = formatEventsAsText(eventsRes);
  const lastEvent = eventsRes[0] ?? null;
  const phaseEndPayload = findLatestPhaseEndPayload(
    eventsRes,
    String(run.currentPhase)
  );

  const totalDocs = Array.isArray((run as any)?.config?.r2Keys)
    ? (run as any).config.r2Keys.length
    : 0;
  const progress = await getSimulationRunProgressSummary(context, {
    runId,
    totalDocs,
  });

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
  const candidateSetsLink = `/audit/simulation?runId=${encodeURIComponent(
    runId
  )}&view=candidate-sets`;
  const timelineFitDecisionsLink = `/audit/simulation?runId=${encodeURIComponent(
    runId
  )}&view=timeline-fit-decisions`;

  const logLink = (next: "events" | "run") => {
    const params = new URLSearchParams();
    params.set("runId", runId);
    if (view) {
      params.set("view", view);
    }
    if (next !== "events") {
      params.set("logView", next);
    }
    return `/audit/simulation?${params.toString()}`;
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Run</CardTitle>
          <CardDescription className="font-mono text-xs">
            {runId}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm">
            <div>
              status=<span className="font-mono">{run.status}</span>
            </div>
            <div>
              phase=
              <span className="font-mono">{String(run.currentPhase)}</span>
            </div>
            <div>
              updated=<span className="font-mono">{run.updatedAt}</span>
            </div>
            {lastEvent ? (
              <div>
                lastEvent=<span className="font-mono">{lastEvent.kind}</span>{" "}
                <span className="text-gray-400">{lastEvent.createdAt}</span>
              </div>
            ) : null}
            {phaseEndPayload ? (
              <div className="text-xs text-gray-600 mt-2">
                phase.end payload:{" "}
                <span className="font-mono">
                  {safeStringify(phaseEndPayload)}
                </span>
              </div>
            ) : null}
          </div>

          <div className="text-xs text-gray-600">
            <div className="font-semibold text-gray-700 mb-1">Progress</div>
            <div className="font-mono">
              docs total={String(progress.totalDocs)} ingest_diff=
              {String(progress.ingestDiff.docs)}/{String(progress.totalDocs)}{" "}
              changed=
              {String(progress.ingestDiff.changed)} unchanged=
              {String(progress.ingestDiff.unchanged)} errors=
              {String(progress.ingestDiff.errors)}
            </div>
            <div className="font-mono">
              micro_batches docsWithBatches=
              {String(progress.microBatches.docsWithBatches)}/
              {String(progress.ingestDiff.changed)} batches=
              {String(progress.microBatches.batches)} cached=
              {String(progress.microBatches.cached)} computed_llm=
              {String(progress.microBatches.computedLlm)} computed_fallback=
              {String(progress.microBatches.computedFallback)}
            </div>
            <div className="font-mono">
              macro_synthesis docs={String(progress.macroSynthesis.docs)}/
              {String(progress.ingestDiff.changed)}
            </div>
            <div className="font-mono">
              materialize_moments docs=
              {String(progress.materializeMoments.docs)}/
              {String(progress.ingestDiff.changed)} moments=
              {String(progress.materializeMoments.moments)}
            </div>
            <div className="font-mono">
              deterministic_linking docs=
              {String(progress.deterministicLinking.docs)}/
              {String(progress.ingestDiff.changed)} decisions=
              {String(progress.deterministicLinking.decisions)}
            </div>
            <div className="font-mono">
              candidate_sets docs={String(progress.candidateSets.docs)}/
              {String(progress.ingestDiff.changed)} sets=
              {String(progress.candidateSets.sets)}
            </div>
            <div className="font-mono">
              timeline_fit docs={String(progress.timelineFit.docs)}/
              {String(progress.ingestDiff.changed)} decisions=
              {String(progress.timelineFit.decisions)}
            </div>
          </div>

          <div className="text-sm">
            <a
              className="text-blue-600 hover:underline"
              href={`/audit/knowledge-graph?${(() => {
                const params = new URLSearchParams();
                const baseNs = run.momentGraphNamespace ?? `sim-${runId}`;
                const prefix = run.momentGraphNamespacePrefix ?? null;
                const effectiveNs = applyMomentGraphNamespacePrefixValue(
                  baseNs,
                  prefix
                );
                if (effectiveNs) {
                  params.set("namespace", effectiveNs);
                } else if (baseNs) {
                  params.set("namespace", baseNs);
                }
                if (prefix) {
                  params.set("prefix", prefix);
                }
                return params.toString();
              })()}`}
            >
              Open in knowledge graph
            </a>
          </div>

          <SimulationRunControls
            mode="run"
            runId={runId}
            currentPhase={String(run.currentPhase)}
            status={String(run.status)}
            phases={[...simulationPhases]}
          />

          <div className="flex gap-2 flex-wrap">
            <a
              className="text-sm text-blue-600 hover:underline"
              href={documentsLink}
            >
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
            <a
              className="text-sm text-blue-600 hover:underline"
              href={candidateSetsLink}
            >
              Candidate sets
            </a>
            <a
              className="text-sm text-blue-600 hover:underline"
              href={timelineFitDecisionsLink}
            >
              Timeline fit decisions
            </a>
          </div>
        </CardContent>
      </Card>

      {String(run.status) === "paused_on_error" && run.lastError ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Error</CardTitle>
            <CardDescription>Run paused on error</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <CopyTextButton
              text={safeStringify(run.lastError)}
              label="Copy error"
            />
            <textarea
              className="w-full border rounded p-2 text-xs font-mono min-h-[140px]"
              readOnly
              value={safeStringify(run.lastError)}
            />
          </CardContent>
        </Card>
      ) : null}

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
      ) : view === "candidate-sets" ? (
        <CandidateSetsCard runId={runId} />
      ) : view === "timeline-fit-decisions" ? (
        <TimelineFitDecisionsCard runId={runId} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Log</CardTitle>
          <CardDescription>
            <span className="mr-3">
              <a
                className={
                  logView === "events"
                    ? "text-blue-700 font-semibold"
                    : "text-blue-600 hover:underline"
                }
                href={logLink("events")}
              >
                Events
              </a>
            </span>
            <span>
              <a
                className={
                  logView === "run"
                    ? "text-blue-700 font-semibold"
                    : "text-blue-600 hover:underline"
                }
                href={logLink("run")}
              >
                Run snapshot
              </a>
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {logView === "run" ? (
            <>
              <div className="flex items-center justify-between gap-2 mb-2">
                <CopyTextButton text={safeStringify(run)} label="Copy run" />
              </div>
              <textarea
                className="w-full border rounded p-2 text-xs font-mono min-h-[60vh] max-h-[80vh]"
                readOnly
                value={safeStringify(run)}
              />
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2 mb-2">
                <CopyTextButton text={eventsText || ""} label="Copy events" />
              </div>
              <textarea
                className="w-full border rounded p-2 text-xs font-mono min-h-[60vh] max-h-[80vh]"
                readOnly
                value={eventsText || "(no events)"}
              />
            </>
          )}
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
  const headers: Record<string, string> = {};
  if (apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

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
        <CardDescription>
          Per-run moment ids written into the moment graph
        </CardDescription>
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
                  r2Key={m.r2Key} stream={m.streamId} idx={String(m.macroIndex)}{" "}
                  parent=
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
        <CardDescription>
          Per-run deterministic_linking decisions
        </CardDescription>
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
                  r2Key={d.r2Key} stream={d.streamId} idx={String(d.macroIndex)}{" "}
                  outcome=
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

async function CandidateSetsCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const sets = await getSimulationRunCandidateSets(context, { runId });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Candidate sets</CardTitle>
        <CardDescription>Per-run candidate_sets outputs</CardDescription>
      </CardHeader>
      <CardContent>
        {sets.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {sets.slice(0, 200).map((s: any) => (
              <div key={s.childMomentId} className="rounded border bg-white">
                <div className="p-2">
                  <div className="font-mono text-xs break-all">
                    {s.childMomentId}
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    r2Key={s.r2Key} stream={s.streamId} idx=
                    {String(s.macroIndex)} candidates=
                    {Array.isArray(s.candidates)
                      ? String(s.candidates.length)
                      : "0"}
                  </div>
                </div>
                <pre className="text-xs bg-gray-50 border-t p-2 overflow-auto max-h-[30vh]">
                  {safeStringify({ stats: s.stats, candidates: s.candidates })}
                </pre>
              </div>
            ))}
            {sets.length > 200 ? (
              <div className="text-xs text-gray-600">
                Showing first 200 of {sets.length}
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function TimelineFitDecisionsCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const decisions = await getSimulationRunTimelineFitDecisions(context, {
    runId,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Timeline fit decisions</CardTitle>
        <CardDescription>Per-run timeline_fit outputs</CardDescription>
      </CardHeader>
      <CardContent>
        {decisions.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {decisions.slice(0, 200).map((d: any) => (
              <div key={d.childMomentId} className="rounded border bg-white">
                <div className="p-2">
                  <div className="font-mono text-xs break-all">
                    {d.childMomentId}
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    r2Key={d.r2Key} stream={d.streamId} idx=
                    {String(d.macroIndex)} outcome=
                    {d.outcome} chosen={d.chosenParentMomentId ?? "null"}
                  </div>
                </div>
                <pre className="text-xs bg-gray-50 border-t p-2 overflow-auto max-h-[30vh]">
                  {safeStringify({ stats: d.stats, decisions: d.decisions })}
                </pre>
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
