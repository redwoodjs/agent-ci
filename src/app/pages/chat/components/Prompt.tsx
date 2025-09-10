"use client";

import { useEffect, useState, useRef } from "react";
import { FormattedMessage, MessageFormatter } from "../utils/messageFormatting";
import { MessageItem } from "./MessageItem";

export const Prompt = ({
  containerId,
  seedUserMessage,
}: {
  containerId: string;
  seedUserMessage?: string;
}) => {
  const [messages, setMessages] = useState<FormattedMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
  const messageFormatter = useRef(new MessageFormatter()).current;

  const onSubmit = async () => {
    if (!prompt.trim() || isLoading) return;

    setIsLoading(true);
    setError(null);

    try {
      // Add user message to conversation
      const userMessage: FormattedMessage = {
        id: `user-${Date.now()}`,
        type: "user",
        content: prompt.trim(),
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Clear prompt
      let currentPrompt = prompt.trim();
      if (seedUserMessage) {
        currentPrompt = seedUserMessage + "\n" + currentPrompt;
      }
      setPrompt("");

      // Call the container-based Claude CLI endpoint
      const response = await fetch("/api/auth/claude/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: currentPrompt,
          containerId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      // Now we need to stream the process output
      const { processId } = data;
      await streamClaudeResponse(processId);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error occurred";
      setError(errorMessage);

      // Add error message to conversation
      const errorMsg: FormattedMessage = {
        id: `error-${Date.now()}`,
        type: "system", // Changed from "error" to "system" to match interface
        content: `Error: ${errorMessage}`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit();
    }
  };

  // Auto-scroll to bottom when messages change, if user hasn't scrolled up
  useEffect(() => {
    if (isScrolledToBottom && messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages, isScrolledToBottom]);

  // Check if user is scrolled to bottom
  const handleScroll = () => {
    if (messagesRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = messagesRef.current;
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10; // 10px tolerance
      setIsScrolledToBottom(isAtBottom);
    }
  };

  const scrollToBottom = () => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      setIsScrolledToBottom(true);
    }
  };

  const streamClaudeResponse = async (processId: string) => {
    try {
      const response = await fetch(
        `/api/auth/claude/stream/${containerId}/${processId}`
      );

      if (!response.ok) {
        throw new Error(`Stream failed: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response stream available");
      }

      let buffer = "";
      let currentMessage: FormattedMessage | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Convert bytes to text
        const chunk = new TextDecoder().decode(value);
        buffer += chunk;

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          // Remove 'data: ' prefix from Server-Sent Events format
          const jsonLine = line.startsWith("data: ") ? line.substring(6) : line;

          try {
            const event = JSON.parse(jsonLine);

            if (event.data) {
              const eventData = event;

              // Process different types of Claude CLI output
              if (eventData.type === "stdout") {
                // Split by newlines and process each JSON object
                const stdoutLines = eventData.data
                  .split("\n")
                  .filter((l: string) => l.trim());

                for (const stdoutLine of stdoutLines) {
                  try {
                    const claudeMessage = JSON.parse(stdoutLine);
                    const formattedMessage =
                      messageFormatter.formatMessage(claudeMessage);

                    if (formattedMessage) {
                      setMessages((prev) => [...prev, formattedMessage]);
                    }
                  } catch (parseError) {
                    // Skip invalid JSON lines
                  }
                }
              } else if (eventData.type === "complete") {
                setIsLoading(false);
                break;
              }
            }
          } catch (e) {
            // Skip malformed JSON - this is expected for some stream data
          }
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Stream error";
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col relative">
      {/* Messages area - flexible, scrollable */}
      <div
        ref={messagesRef}
        className="flex-1 overflow-y-auto"
        onScroll={handleScroll}
      >
        <div className="p-4 bg-gray-50 min-h-full">
          {messages.length === 0 ? (
            <div className="text-center text-gray-500 mt-8">
              <p>Start a conversation with Claude!</p>
              <p className="text-sm mt-2">
                Use Ctrl+Enter or Cmd+Enter to send messages
              </p>
            </div>
          ) : (
            <div className="space-y-4 max-w-4xl mx-auto">
              {messages.map((message, i) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  prevMessage={i > 0 ? messages[i - 1] : undefined}
                />
              ))}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-white border border-gray-200 rounded-lg px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                      <div
                        className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"
                        style={{ animationDelay: "0.2s" }}
                      ></div>
                      <div
                        className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"
                        style={{ animationDelay: "0.4s" }}
                      ></div>
                      <span className="text-gray-600 text-sm ml-2">
                        Claude is thinking...
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Scroll to bottom button */}
        {!isScrolledToBottom && (
          <div className="absolute bottom-20 right-6">
            <button
              onClick={scrollToBottom}
              className="bg-blue-500 hover:bg-blue-600 text-white p-2 rounded-full shadow-lg transition-colors"
              title="Scroll to bottom"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 14l-7 7m0 0l-7-7m7 7V3"
                />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Input area - fixed at bottom */}
      <div className="border-t bg-white p-4 flex-shrink-0">
        <div className="max-w-4xl mx-auto">
          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-red-800 text-sm">{error}</p>
            </div>
          )}
          <div className="flex gap-3">
            <textarea
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="Ask Claude a question... (Ctrl+Enter to send)"
              rows={2}
            />
            <button
              onClick={onSubmit}
              disabled={isLoading || !prompt.trim()}
              className="px-6 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-md font-medium transition-colors"
            >
              {isLoading ? "Sending..." : "Send"}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Container: {containerId} • Press Ctrl+Enter or Cmd+Enter to send
          </p>
        </div>
      </div>
    </div>
  );
};
