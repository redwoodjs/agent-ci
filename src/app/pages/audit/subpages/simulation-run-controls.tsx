"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  startSimulationRunAction,
  runAllSimulationRunAction,
  runSampleSimulationRunAction,
  advanceSimulationRunAction,
  pauseSimulationRunAction,
  resumeSimulationRunAction,
  restartSimulationRunAction,
} from "./simulation-actions";

export function SimulationRunControls(
  props:
    | { mode: "start" }
    | {
        mode: "run";
        runId: string;
        status: string;
        currentPhase: string;
        phases: string[];
      }
) {
  if (props.mode === "start") {
    return <StartControls />;
  }
  return (
    <RunControls
      runId={props.runId}
      status={props.status}
      currentPhase={props.currentPhase}
      phases={props.phases}
    />
  );
}

function StartControls() {
  const [loading, setLoading] = useState(false);
  const [r2KeysText, setR2KeysText] = useState("");
  const [namespace, setNamespace] = useState("");
  const [prefix, setPrefix] = useState("");
  const [r2Prefix, setR2Prefix] = useState("");
  const [maxPages, setMaxPages] = useState("5");
  const [sampleSize, setSampleSize] = useState("20");
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setLoading(true);
    setError(null);
    try {
      const r2Keys = r2KeysText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const res = await startSimulationRunAction({
        r2Keys,
        momentGraphNamespace: namespace.trim() || null,
        momentGraphNamespacePrefix: prefix.trim() || null,
      });
      if (res.success && res.runId) {
        window.location.href = `/audit/simulation?runId=${encodeURIComponent(
          res.runId
        )}`;
        return;
      }
      setError(res.error || "Failed to start run");
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  };

  const runAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const maxPagesNum = Number(maxPages);
      const res = await runAllSimulationRunAction({
        r2Prefix: r2Prefix.trim(),
        limitPerPage: 200,
        maxPages: Number.isFinite(maxPagesNum) ? Math.floor(maxPagesNum) : 5,
        momentGraphNamespace: namespace.trim() || null,
        momentGraphNamespacePrefix: prefix.trim() || null,
      });
      if (res.success && res.runId) {
        window.location.href = `/audit/simulation?runId=${encodeURIComponent(
          res.runId
        )}&autorun=1`;
        return;
      }
      setError(res.error || "Failed to run all");
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  };

  const runSample = async () => {
    setLoading(true);
    setError(null);
    try {
      const maxPagesNum = Number(maxPages);
      const sampleSizeNum = Number(sampleSize);
      const res = await runSampleSimulationRunAction({
        r2Prefix: r2Prefix.trim(),
        limitPerPage: 200,
        maxPages: Number.isFinite(maxPagesNum) ? Math.floor(maxPagesNum) : 5,
        sampleSize: Number.isFinite(sampleSizeNum)
          ? Math.floor(sampleSizeNum)
          : 20,
        momentGraphNamespace: namespace.trim() || null,
        momentGraphNamespacePrefix: prefix.trim() || null,
      });
      if (res.success && res.runId) {
        window.location.href = `/audit/simulation?runId=${encodeURIComponent(
          res.runId
        )}&autorun=1`;
        return;
      }
      setError(res.error || "Failed to run sample");
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-xs text-gray-600 font-semibold uppercase">
          Manual input
        </div>
        <div className="text-xs text-gray-600">
          Optional: list R2 keys (one per line). Empty runs are allowed for UI
          wiring checks.
        </div>
        <textarea
          className="w-full border rounded p-2 text-xs font-mono min-h-[90px]"
          placeholder={"github/...\ndiscord/..."}
          value={r2KeysText}
          onChange={(e) => setR2KeysText(e.target.value)}
        />
      </div>

      <div className="space-y-2 bg-gray-50 p-3 rounded border">
        <div className="text-xs text-gray-600 font-semibold uppercase">
          Bulk / Sample Configuration
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="text-xs text-gray-600">R2 prefix</div>
            <Input
              placeholder="e.g. github/ or discord/"
              value={r2Prefix}
              onChange={(e) => setR2Prefix(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-gray-600">Max listing pages</div>
            <Input
              placeholder="5"
              value={maxPages}
              onChange={(e) => setMaxPages(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1 mt-2">
          <div className="text-xs text-gray-600">
            Sample size (automatically picks balanced mix of Issues, PRs,
            Discord, Cursor)
          </div>
          <Input
            placeholder="20"
            value={sampleSize}
            onChange={(e) => setSampleSize(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs text-gray-600 font-semibold uppercase">
          Namespace
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            placeholder="momentGraphNamespace (optional)"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
          />
          <Input
            placeholder="momentGraphNamespacePrefix (optional)"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-2 items-center pt-2 border-t">
        <Button disabled={loading} onClick={start}>
          {loading ? "Starting…" : "Start run"}
        </Button>
        <Button disabled={loading} onClick={runAll} variant="secondary">
          {loading ? "Running…" : "Run all"}
        </Button>
        <Button disabled={loading} onClick={runSample} variant="secondary">
          {loading ? "Running…" : "Run sample"}
        </Button>
        {error ? <div className="text-xs text-red-700">{error}</div> : null}
      </div>
    </div>
  );
}

function RunControls({
  runId,
  status,
  currentPhase,
  phases,
}: {
  runId: string;
  status: string;
  currentPhase: string;
  phases: string[];
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartPhase, setRestartPhase] = useState(currentPhase);
  const [autoStatus, setAutoStatus] = useState<{
    status: string;
    currentPhase: string;
    steps: number;
    error?: string;
  } | null>(null);
  const stopRef = useRef(false);

  const runAction = async (
    name: string,
    fn: () => Promise<{ success: boolean; error?: string }>
  ) => {
    setLoading(name);
    setError(null);
    try {
      const res = await fn();
      if (!res.success) {
        setError(res.error || "Action failed");
        setLoading(null);
        return;
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(null);
    }
  };

  const runAuto = async () => {
    setError(null);
    stopRef.current = false;
    setAutoStatus({ status, currentPhase, steps: 0 });
    const maxSteps = 100;
    const maxMs = 5 * 60 * 1000;
    const startedAt = Date.now();
    let steps = 0;
    let lastStatus = status;
    let lastPhase = currentPhase;

    while (true) {
      if (stopRef.current) {
        break;
      }
      if (Date.now() - startedAt > maxMs) {
        const msg = "Auto-run exceeded time limit (5m)";
        setError(msg);
        setAutoStatus((prev) => (prev ? { ...prev, error: msg } : null));
        break;
      }
      if (steps >= maxSteps) {
        const msg = "Auto-run exceeded step limit (100)";
        setError(msg);
        setAutoStatus((prev) => (prev ? { ...prev, error: msg } : null));
        break;
      }
      if (lastStatus !== "running") {
        break;
      }

      try {
        const res = await advanceSimulationRunAction({ runId });
        if (!res.success) {
          const msg = res.error || "Advance failed";
          setError(msg);
          setAutoStatus((prev) => (prev ? { ...prev, error: msg } : null));
          break;
        }
        lastStatus =
          typeof (res as any).status === "string" ? (res as any).status : "running";
        lastPhase =
          typeof (res as any).currentPhase === "string"
            ? (res as any).currentPhase
            : lastPhase;
        steps++;
        setAutoStatus({ status: lastStatus, currentPhase: lastPhase, steps });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setAutoStatus((prev) => (prev ? { ...prev, error: msg } : null));
        break;
      }
    }

    if (!stopRef.current) {
      window.location.reload();
    }
  };

  const stopAuto = () => {
    stopRef.current = true;
    setLoading(null);
  };

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("autorun") === "1" && status === "running") {
      runAuto().catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">
        <Button
          disabled={loading !== null || status !== "running" || autoStatus !== null}
          onClick={() => runAuto()}
        >
          {autoStatus ? "Running Auto…" : "Run (Auto)"}
        </Button>
        <Button
          disabled={autoStatus === null}
          onClick={() => stopAuto()}
          variant="secondary"
        >
          Stop
        </Button>
        <div className="w-px h-6 bg-gray-200 mx-1" />
        <Button
          disabled={loading !== null || status !== "running"}
          onClick={() =>
            runAction("advance", () => advanceSimulationRunAction({ runId }))
          }
        >
          {loading === "advance" ? "Advancing…" : "Advance (Single Step)"}
        </Button>
        <Button
          disabled={loading !== null || status === "paused_manual"}
          onClick={() =>
            runAction("pause", () => pauseSimulationRunAction({ runId }))
          }
          variant="secondary"
        >
          {loading === "pause" ? "Pausing…" : "Pause"}
        </Button>
        <Button
          disabled={loading !== null || status !== "paused_manual"}
          onClick={() =>
            runAction("resume", () => resumeSimulationRunAction({ runId }))
          }
          variant="secondary"
        >
          {loading === "resume" ? "Resuming…" : "Resume"}
        </Button>
      </div>

      <div className="flex gap-2 items-center flex-wrap pt-2 border-t">
        <span className="text-xs text-gray-500 uppercase font-semibold">
          Reset:
        </span>
        <select
          className="border rounded px-2 py-1 text-sm font-mono bg-white"
          value={restartPhase}
          onChange={(e) => setRestartPhase(e.target.value)}
        >
          {phases.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <Button
          disabled={loading !== null}
          onClick={() =>
            runAction("restart", () =>
              restartSimulationRunAction({ runId, phase: restartPhase })
            )
          }
          variant="destructive"
          size="sm"
        >
          {loading === "restart" ? "Restarting…" : "Restart from phase"}
        </Button>
        {error ? <div className="text-xs text-red-700">{error}</div> : null}
      </div>
      {autoStatus ? (
        <div className="text-xs bg-blue-50 text-blue-800 p-2 rounded border border-blue-100 flex justify-between items-center">
          <div>
            <strong>Auto-running:</strong> status={autoStatus.status} phase={autoStatus.currentPhase} steps=
            {autoStatus.steps}
            {autoStatus.error ? <span className="text-red-600 ml-2">Error: {autoStatus.error}</span> : null}
          </div>
          <Button variant="ghost" size="sm" className="h-6 text-blue-800" onClick={stopAuto}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

