"use client";

import { ProcessLogs } from "../ProcessLogs";

export function BootstrapLogs({
  containerId,
  processId,
}: {
  containerId: string;
  processId: string;
}) {
  return (
    <ProcessLogs
      containerId={containerId}
      processId={processId}
      onComplete={() => {
        window.location.reload();
      }}
    />
  );
}
