"use client";

import { useState, useEffect } from "react";
import { consumeEventStream } from "rwsdk/client";
import { streamLogs } from "./actions";

interface Log {
  data: string;
  timestamp: string;
}

export function ProcessLogs({
  containerId,
  processId,
  completeMessage,
  onComplete,
}: {
  containerId: string;
  processId: string;
  completeMessage?: string;
  onComplete?: () => void;
}) {
  const [logs, setLogs] = useState<Log[]>([]);

  useEffect(() => {
    async function fetchLogs() {
      const eventStream = await streamLogs(containerId, processId);
      eventStream.pipeTo(
        consumeEventStream({
          onChunk: (event) => {
            const data: Log = JSON.parse(event.data);
            // TOODO: Make this agnostic.
            if (completeMessage && data.data.includes(completeMessage)) {
              onComplete?.();
            } else {
              setLogs((prevLogs) => [...prevLogs, data]);
            }
          },
        })
      );
    }
    fetchLogs();
  }, []);

  return (
    <div>
      <h1>Logs {processId}</h1>
      <code>
        <ol>
          {logs.map((log) => (
            <li key={log.timestamp}>{log.data}</li>
          ))}
        </ol>
      </code>
    </div>
  );
}
