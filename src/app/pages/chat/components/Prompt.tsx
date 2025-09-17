"use client";

import { useEffect, useState, useRef } from "react";
import { FormattedMessage, MessageFormatter } from "../utils/messageFormatting";
import { MessageItem } from "./MessageItem";
import { consumeEventStream } from "rwsdk/client";
import { streamProcess } from "../actions";
import { ClaudeModel } from "@/types/claude";
import { sendAndStreamClaudeMessage } from "./action";

export const Prompt = ({
  containerId,
  seedUserMessage,
  autoFocus = false,
}: {
  containerId: string;
  seedUserMessage?: string;
  autoFocus?: boolean;
}) => {
  const [messages, setMessages] = useState<FormattedMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(true);
  const messageFormatter = useRef(new MessageFormatter()).current;
  const streamedProcessIdsRef = useRef<Set<string>>(new Set());
  const [model, setModel] = useState<ClaudeModel>("default");

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

      const stream = await sendAndStreamClaudeMessage(
        containerId,
        currentPrompt,
        model
      );

      await stream.pipeTo(
        consumeEventStream({
          onChunk: (event) => {
            let data = null;
            try {
              data = JSON.parse(event.data);
            } catch (err) {
              console.error(err);
            }

            if (data.type === "stdout") {
              const stdoutLines = String(data.data)
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
                } catch (_) {
                  // Ignore lines that are not valid JSON messages
                }
              }
            } else if (data.type === "complete") {
              // we are now done.
              setIsLoading(false);
            }
          },
        })
      );
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

  // Auto-focus textarea when autoFocus prop is true
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

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
              ref={textareaRef}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder="Ask Claude a question... (Ctrl+Enter to send)"
              rows={2}
            />
            <div className="flex flex-col gap-2">
              <select
                className="px-2 py-2 border border-gray-300 rounded-md bg-white"
                value={model}
                onChange={(e) => setModel(e.target.value as ClaudeModel)}
                title="Choose Claude model"
              >
                <option value="default">default</option>
                <option value="sonnet">sonnet</option>
                <option value="opus">opus</option>
                <option value="haiku">haiku</option>
                <option value="sonnet[1m]">sonnet[1m]</option>
                <option value="opusplan">opusplan</option>
              </select>
              <button
                onClick={onSubmit}
                disabled={isLoading || !prompt.trim()}
                className="px-6 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-md font-medium transition-colors"
              >
                {isLoading ? "Sending..." : "Send"}
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Container: {containerId} • Model: {model} • Press Ctrl+Enter or
            Cmd+Enter to send
          </p>
        </div>
      </div>
    </div>
  );
};
