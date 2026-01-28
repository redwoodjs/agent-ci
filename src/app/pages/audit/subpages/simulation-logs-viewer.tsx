"use client";

import { useEffect, useState, useRef } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/card";
import { CopyTextButton } from "./copy-text-button";
import { getSimulationRunLogStateAction } from "./simulation-actions";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function SimulationLogsViewer({
  runId,
  initialEventsText,
  initialRunText,
  logView,
  logLink,
}: {
  runId: string;
  initialEventsText: string;
  initialRunText: string;
  logView: "events" | "run";
  logLink: (next: "events" | "run") => string;
}) {
  const [eventsText, setEventsText] = useState(initialEventsText);
  const [runText, setRunText] = useState(initialRunText);
  const [lastCheck, setLastCheck] = useState<string>("");
  
  // Polling logic
  useEffect(() => {
    let mounted = true;
    const interval = setInterval(async () => {
      try {
        const res = await getSimulationRunLogStateAction({ runId });
        if (mounted && res.success && res.data) {
          setEventsText(res.data.eventsText);
          setRunText(safeStringify(res.data.run));
          setLastCheck(res.data.checkTime);
        }
      } catch (e) {
        console.error("Failed to poll simulation logs", e);
      }
    }, 2000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [runId]);

  return (
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
          {lastCheck ? (
            <span className="float-right text-xs font-mono text-gray-400">
              updated: {lastCheck.split("T")[1]?.slice(0, 8)}
            </span>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {logView === "run" ? (
          <>
            <div className="flex items-center justify-between gap-2 mb-2">
              <CopyTextButton text={runText} label="Copy run" />
            </div>
            <textarea
              className="w-full border rounded p-2 text-xs font-mono min-h-[60vh] max-h-[80vh]"
              readOnly
              value={runText}
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
  );
}
