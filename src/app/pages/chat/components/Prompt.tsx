"use client";

import { useEffect, useState } from "react";
import { sendMessage, streamProcess } from "../action";
import { consumeEventStream } from "rwsdk/client";
import type { ClaudeMessage, FormattedMessage } from "./messageFormatting";
import { ClaudeMessage as ClaudeMessageComponent } from "./ClaudeMessage";
import { MessageFormatter } from "./messageFormatting";

const formatter = new MessageFormatter();

export const Prompt = ({ containerId }: { containerId: string }) => {
  const [message, setMessage] = useState([]);
  const [prompt, setPrompt] = useState("can you tell me which routes I have?");
  const [isLoading, setIsLoading] = useState(false);
  const [processId, setProcessId] = useState<string | null>(null);

  const onSubmit = async () => {
    setIsLoading(true);

    const response = await sendMessage(containerId, prompt);
    setProcessId(response.id);
  };

  useEffect(() => {
    if (processId) {
      let buffer = "";

      const x = async () => {
        const stream = await streamProcess(containerId, processId);
        stream.pipeTo(
          consumeEventStream({
            onChunk: (event) => {
              // this can be a partial

              if (event.data) {
                const d = JSON.parse(event.data);
                switch (d.type) {
                  case "stdout":
                    buffer += d.data;

                    const lines = buffer.split("\n");

                    buffer = lines.pop() || "";

                    for (const line of lines) {
                      if (!line.trim()) continue;
                      try {
                        const m = JSON.parse(line);
                        console.log(m);
                        const jsonMessage = formatter.formatMessage(m);

                        setMessage((prev) => [...prev, jsonMessage]);
                      } catch (e) {
                        console.log(e);
                      }
                    }

                  case "stderr":
                    break;
                  case "complete":
                    setIsLoading(false);
                    break;
                }
              }
            },
          })
        );
      };
      x();
    }
  }, [processId]);

  return (
    <>
      <div className="h-full w-full">
        <div className="h-full w-full bg-black dark:bg-black">
          {message.map((m, i) => {
            return (
              <ClaudeMessageComponent
                key={"message-" + i}
                message={m}
                prevMessage={message[i - 1] ?? undefined}
              />
            );
          })}
        </div>
      </div>
      <textarea
        className="w-full h-full bg-white dark:bg-black"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="flex justify-end">
        {isLoading && (
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
        )}
        <button onClick={onSubmit} disabled={isLoading}>
          Send
        </button>
      </div>
    </>
  );
};
