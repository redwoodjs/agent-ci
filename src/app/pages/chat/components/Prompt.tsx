"use client";

import { useState } from "react";

interface FormattedMessage {
  id: string;
  type: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

export const Prompt = ({
  containerId,
  seedUserMessage,
}: {
  containerId: string;
  seedUserMessage?: string;
}) => {
  const [messages, setMessages] = useState<FormattedMessage[]>([]);
  const [prompt, setPrompt] = useState(
    "Can you help me with a coding question?"
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

                    // Handle different message types
                    if (
                      claudeMessage.type === "assistant" &&
                      claudeMessage.message?.content
                    ) {
                      // Assistant text and tool calls
                      let textContent = "";
                      let toolCalls: any[] = [];

                      for (const contentItem of claudeMessage.message.content) {
                        if (contentItem.type === "text") {
                          textContent += contentItem.text;
                        } else if (contentItem.type === "tool_use") {
                          toolCalls.push({
                            name: contentItem.name,
                            input: contentItem.input,
                            id: contentItem.id,
                          });
                        }
                      }

                      // Add assistant message with text
                      if (textContent) {
                        const assistantMessage: FormattedMessage = {
                          id: `assistant-${Date.now()}`,
                          type: "assistant",
                          content: textContent,
                          timestamp: new Date().toISOString(),
                        };
                        setMessages((prev) => [...prev, assistantMessage]);
                      }

                      // Add tool call messages
                      for (const toolCall of toolCalls) {
                        const toolMessage: FormattedMessage = {
                          id: `tool-${Date.now()}-${toolCall.id}`,
                          type: "system",
                          content: `🛠️ Using ${toolCall.name}${
                            toolCall.input
                              ? `: ${JSON.stringify(toolCall.input, null, 2)}`
                              : ""
                          }`,
                          timestamp: new Date().toISOString(),
                        };
                        setMessages((prev) => [...prev, toolMessage]);
                      }
                    } else if (
                      claudeMessage.type === "user" &&
                      claudeMessage.message?.content
                    ) {
                      // Tool results
                      for (const contentItem of claudeMessage.message.content) {
                        if (contentItem.type === "tool_result") {
                          const resultMessage: FormattedMessage = {
                            id: `result-${Date.now()}-${
                              contentItem.tool_use_id
                            }`,
                            type: "system",
                            content: `✅ Tool result: ${contentItem.content}`,
                            timestamp: new Date().toISOString(),
                          };
                          setMessages((prev) => [...prev, resultMessage]);
                        }
                      }
                    } else if (claudeMessage.type === "result") {
                      // Final result summary
                      const summary = `💰 ${
                        claudeMessage.total_cost_usd || 0
                      } • ${Math.round(
                        (claudeMessage.duration_ms || 0) / 1000
                      )}s • ${claudeMessage.num_turns || 0} turns`;
                      const resultMessage: FormattedMessage = {
                        id: `summary-${Date.now()}`,
                        type: "system",
                        content: summary,
                        timestamp: new Date().toISOString(),
                      };
                      setMessages((prev) => [...prev, resultMessage]);
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
    <div className="h-full flex flex-1 flex-col">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 bg-gray-50">
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
              <div
                key={`message-${i}`}
                className={`flex ${
                  message.type === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                    message.type === "user"
                      ? "bg-blue-500 text-white"
                      : message.type === "error"
                      ? "bg-red-100 text-red-800 border border-red-300"
                      : "bg-white text-gray-800 border border-gray-200"
                  }`}
                >
                  <div className="whitespace-pre-wrap">{message.content}</div>
                  <div className="text-xs mt-1 opacity-70">
                    {new Date(message.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              </div>
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

      {/* Input area */}
      <div className="border-t bg-white p-4">
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
