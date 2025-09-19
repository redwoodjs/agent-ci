"use client";

import { ProcessLogs } from "../ProcessLogs";

export function BootLogs({
  containerId,
  processId,
}: {
  containerId: string;
  processId: string;
}) {
  return (
    <div>
      <h1>Boot Logs</h1>
      <ProcessLogs
        containerId={containerId}
        processId={processId}
        onComplete={() => {
          window.location.reload();
        }}
      />
    </div>
  );
}
