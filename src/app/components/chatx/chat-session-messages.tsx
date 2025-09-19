"use client";

import { useEffect, useState, useRef } from "react";
import { consumeEventStream } from "rwsdk/client";
import { streamSessionMessages, prompt } from "./actions";
import { Button } from "../ui/button";

interface Messages {
  [messageID: string]: { text?: string };
}

export function ChatSessionMessages({ containerId }: { containerId: string }) {
  // NOTE(peterp, 2025-09-18): this stores the `messageId` in an array.
  // We use this to determine the position of the message that needs updating.
  const [chatLog, setChatLog] = useState<string[]>([]);
  const chatLogRef = useRef<string[]>([]);
  const [messages, setMessages] = useState<Messages>({});
  const [promptText, setPromptText] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    chatLogRef.current = chatLog;
  }, [chatLog]);

  // TODO(peterp, 2025-09-18): Do we need to handle disconnects and retries?
  useEffect(() => {
    const fetchStream = async () => {
      const stream = await streamSessionMessages({ containerId });
      stream.pipeTo(
        consumeEventStream({
          onChunk: (event) => {
            const { messageID, text } = JSON.parse(event.data);
            const currentChatLog = chatLogRef.current;
            const index = currentChatLog.indexOf(messageID);
            if (index === -1) {
              const newChatLog = [...currentChatLog, messageID];
              chatLogRef.current = newChatLog;
              setChatLog(newChatLog);
            }

            if (text) {
              setMessages((prev) => ({
                ...prev,
                [messageID]: {
                  text,
                },
              }));
            }
          },
        })
      );
    };

    fetchStream();
  }, [containerId]);

  return (
    <div>
      Prompt
      <ol>
        {chatLog.map((messageID) => (
          <li key={messageID}>
            {messageID}x: {messages[messageID]?.text}
          </li>
        ))}
      </ol>
      <hr />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          let x = promptText;
          setIsLoading(true);
          setPromptText("");
          await prompt({ containerId, text: x });
          setIsLoading(false);
        }}
      >
        <textarea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (promptText.length && !isLoading) {
                const form = e.currentTarget.closest("form");
                if (form) {
                  form.requestSubmit();
                }
              }
            }
          }}
        />
        <Button disabled={!promptText.length || isLoading} type="submit">
          {isLoading ? "Sending..." : "Send"}
        </Button>
      </form>
    </div>
  );
}
