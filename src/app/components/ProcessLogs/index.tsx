"use client";

import { useState, useEffect, useRef } from "react";
import { consumeEventStream } from "rwsdk/client";
import { streamLogs } from "./actions";

interface Log {
  data: string;
  type?: string;
  exitCode?: number;
}

export function ProcessLogs({
  containerId,
  processId,
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
      try {
        const eventStream = await streamLogs(containerId, processId);
        eventStream.pipeTo(
          consumeEventStream({
            onChunk: (event) => {
              console.log(event);
              console.log("event", event);
              if (event.data) {
                const data: Log = JSON.parse(event.data);
                switch (data.type) {
                  case "complete":
                    {
                      setLogs((prevLogs) => [
                        ...prevLogs,
                        {
                          data: "Exited with code " + data.exitCode,
                        },
                      ]);
                      // Process completed naturally, call onComplete callback
                      onComplete?.();
                    }
                    break;
                  case "stdout":
                    {
                      setLogs((prevLogs) => [...prevLogs, data]);
                    }
                    break;
                  case "stderr":
                    {
                      setLogs((prevLogs) => [...prevLogs, data]);
                    }
                    break;
                }
              }
            },
          })
        );
      } catch (error) {
        // Handle abort or other errors
        if (error instanceof Error && error.name === "AbortError") {
          console.log("Log streaming was cancelled");
        } else {
          console.error("Error streaming logs:", error);
        }
      }
    }

    fetchLogs();
  }, [containerId, processId, onComplete]);

  return (
    <div>
      <h1>Logs: {processId}</h1>
      <code>
        <ol>
          {logs.map((log, i) => (
            <li key={log + "-" + i}>
              <pre>{log.data}</pre>
            </li>
          ))}
        </ol>
      </code>
    </div>
  );
}
