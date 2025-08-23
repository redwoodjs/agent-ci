"use client";

import { ProcessLogs } from "../ProcessLogs";

export function LongRunningProcessLogs({
  containerId,
  processId,
}: {
  containerId: string;
  processId: string;
}) {
  return <ProcessLogs containerId={containerId} processId={processId} />;
}
