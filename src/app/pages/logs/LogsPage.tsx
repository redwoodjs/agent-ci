"use client";

import { useState, useEffect } from "react";
import { RequestInfo } from "rwsdk/worker";
import { consumeEventStream } from "rwsdk/client";
import { streamLogs } from "./functions";

interface Log {
  data: string;
  timestamp: string;
}

export function LogsPage({ params }: RequestInfo) {
  const { containerId, processId } = params;

  const [logs, setLogs] = useState<Log[]>([]);

  useEffect(() => {
    async function fetchLogs() {
      const eventStream = await streamLogs(containerId, processId);
      eventStream.pipeTo(
        consumeEventStream({
          onChunk: (event) => {
            const data: Log = JSON.parse(event.data);
            setLogs((prevLogs) => [...prevLogs, data]);
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
