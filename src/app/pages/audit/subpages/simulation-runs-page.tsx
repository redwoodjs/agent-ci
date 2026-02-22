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
  getSimulationRunMacroClassifiedOutputs,
  getSimulationRunLinkDecisions,
  getSimulationRunCandidateSets,
  getSimulationRunTimelineFitDecisions,
  getSimulationRunMaterializedMoments,
  getSimulationRunCosts,
} from "@/app/engine/databases/simulationState";
import {
  simulationPhasesOrdered,
  simulationRunViews,
} from "@/app/pipelines/registry";
import { getSimulationRunProgressSummary } from "@/app/engine/simulation/runProgress";
import { getMoments } from "@/app/engine/databases/momentGraph";
import { SimulationRunControls } from "./simulation-run-controls";
import { CopyTextButton } from "./copy-text-button";
import { SimulationLogsViewer } from "./simulation-logs-viewer";
import { CostAnalysisCard } from "./cost-analysis-card";

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

type MomentPreview = {
  id: string;
  title: string;
  summary: string;
  documentId: string;
  isSubject?: boolean;
  subjectKind?: string;
  subjectReason?: string;
};

function momentPreviewFrom(m: any, id: string): MomentPreview {
  return {
    id,
    title: typeof m?.title === "string" ? m.title : "",
    summary: typeof m?.summary === "string" ? m.summary : "",
    documentId: typeof m?.documentId === "string" ? m.documentId : "",
    isSubject: Boolean(m?.isSubject),
    subjectKind: typeof m?.subjectKind === "string" ? m.subjectKind : undefined,
    subjectReason:
      typeof m?.subjectReason === "string" ? m.subjectReason : undefined,
  };
}

async function loadMomentPreviews(
  ids: string[],
  context: { env: Cloudflare.Env; momentGraphNamespace: string | null },
): Promise<Map<string, MomentPreview>> {
  const deduped = Array.from(
    new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0)),
  );
  const out = new Map<string, MomentPreview>();
  if (deduped.length === 0) {
    return out;
  }
  const moments = await getMoments(deduped, context as any);
  for (const id of deduped) {
    const m = moments.get(id);
    if (m) {
      out.set(id, momentPreviewFrom(m as any, id));
    }
  }
  return out;
}

function formatEventsAsText(
  events: Array<{
    createdAt: string;
    level: string;
    kind: string;
    payload: any;
  }>,
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

export function isSimulationRunViewId(
  id: string | null | undefined,
): id is string {
  if (!id) {
    return false;
  }
  return simulationRunViews.some((v) => v.id === id);
}

function findLatestPhaseEndPayload(
  events: Array<{
    createdAt: string;
    level: string;
    kind: string;
    payload: any;
  }>,
  phase: string,
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
  const view = isSimulationRunViewId(viewRaw) ? viewRaw : null;
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
  view: string | null;
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
                      {typeof r.estimatedCostUsd === "number" && (
                        <div className="text-xs font-semibold text-green-700 mt-1">
                          Est. Cost: ${r.estimatedCostUsd.toFixed(4)}
                          {r.config?.r2Keys?.length > 0 &&
                            ` ($${(
                              r.estimatedCostUsd / r.config.r2Keys.length
                            ).toFixed(4)}/doc)`}
                        </div>
                      )}
                      <div className="text-xs text-gray-600 mt-1 font-mono">
                        ns={r.momentGraphNamespace ?? "null"} prefix=
                        {r.momentGraphNamespacePrefix ?? "null"}
                      </div>
                    </div>
                    <a
                      className="text-sm text-blue-600 hover:underline"
                      href={`/audit/simulation?runId=${encodeURIComponent(
                        r.runId,
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

  const [run, eventsRes, costs] = await Promise.all([
    getSimulationRunById(context, { runId }),
    getSimulationRunEvents(context, { runId, limit: 10000 }),
    getSimulationRunCosts(context, { runId }),
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
    String(run.currentPhase),
  );

  const baseNamespace = run.momentGraphNamespace;
  const namespacePrefix = run.momentGraphNamespacePrefix ?? null;
  const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
    baseNamespace,
    namespacePrefix,
  );

  const totalDocs = Array.isArray((run as any)?.config?.r2Keys)
    ? (run as any).config.r2Keys.length
    : 0;
  const progress = await getSimulationRunProgressSummary(context, {
    runId,
    totalDocs,
  });

  const viewLink = (id: string) =>
    `/audit/simulation?runId=${encodeURIComponent(
      runId,
    )}&view=${encodeURIComponent(id)}`;

  const viewDef = view ? simulationRunViews.find((v) => v.id === view) : null;

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

  const isCostView = view === "costs";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex justify-between items-start">
            <div>
              <CardTitle className="text-lg">Run</CardTitle>
              <CardDescription className="font-mono text-xs">
                {runId}
              </CardDescription>
            </div>
            <a
              href={viewLink("costs")}
              className={`px-3 py-1 rounded-full text-xs font-semibold ${
                isCostView
                  ? "bg-green-100 text-green-800 border border-green-200"
                  : "bg-gray-100 text-gray-800 border border-gray-200 hover:bg-gray-200"
              }`}
            >
              Cost Analysis: ${costs.totalCostUsd.toFixed(3)}
            </a>
          </div>
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
            <div className="mt-2 pt-2 border-t">
              <div className="font-semibold text-green-700">
                Estimated Total Cost: ${costs.totalCostUsd.toFixed(4)}
              </div>
              <div className="text-xs text-gray-600">
                {costs.totalCallCount} calls | {costs.totalInputTokens} in |{" "}
                {costs.totalOutputTokens} out
              </div>
              {totalDocs > 0 && (
                <div className="text-xs font-semibold text-gray-700 mt-1">
                  Cost per document: $
                  {(costs.totalCostUsd / totalDocs).toFixed(4)}
                </div>
              )}
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
              macro_classification docs=
              {String(progress.macroClassification.docs)}/
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
                const baseNs = run.momentGraphNamespace;
                const prefix = run.momentGraphNamespacePrefix ?? null;

                if (baseNs) {
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
            phases={[...simulationPhasesOrdered]}
          />

          <div className="flex gap-2 flex-wrap">
            {simulationRunViews.map((v) => (
              <a
                key={v.id}
                className="text-sm text-blue-600 hover:underline"
                href={viewLink(v.id)}
              >
                {v.label}
              </a>
            ))}
            <a
              className="text-sm text-green-600 hover:underline font-semibold"
              href={viewLink("costs")}
            >
              Cost Analysis
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

      {isCostView ? (
        <CostAnalysisCard costs={costs} />
      ) : viewDef ? (
        <viewDef.component
          runId={runId}
          effectiveNamespace={effectiveNamespace}
        />
      ) : null}

      <SimulationLogsViewer
        runId={runId}
        initialEventsText={eventsText}
        initialRunText={safeStringify(run)}
        logView={logView}
        view={view}
      />
    </div>
  );
}
