"use client";

import { useEffect, useState } from "react";

import { startContainer } from "./actions";
import { consumeEventStream } from "rwsdk/client";

export function InitSandboxLogs({ containerId }: { containerId: string }) {
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    async function fetchLogs() {
      const eventStream = await startContainer({ containerId });
      eventStream.pipeTo(
        consumeEventStream({
          onChunk: (event) => {
            console.log("event", event);
            setLogs((prevLogs) => [...prevLogs, event.data]);
          },
        })
      );
    }
    fetchLogs();
  }, []);

  return (
    <div>
      {logs.map((log, index) => (
        <div key={"log-" + index}>{log}</div>
      ))}
    </div>
  );
}
