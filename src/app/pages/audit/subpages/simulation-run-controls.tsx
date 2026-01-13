"use client";

import { useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  startSimulationRunAction,
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

  return (
    <div className="space-y-2">
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
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
      <div className="flex gap-2 items-center">
        <Button disabled={loading} onClick={start}>
          {loading ? "Starting…" : "Start run"}
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

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        <Button
          disabled={loading !== null || status !== "running"}
          onClick={() =>
            runAction("advance", () => advanceSimulationRunAction({ runId }))
          }
        >
          {loading === "advance" ? "Advancing…" : "Advance"}
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

      <div className="flex gap-2 items-center flex-wrap">
        <select
          className="border rounded px-2 py-1 text-sm"
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
        >
          {loading === "restart" ? "Restarting…" : "Restart from phase"}
        </Button>
        {error ? <div className="text-xs text-red-700">{error}</div> : null}
      </div>
    </div>
  );
}

