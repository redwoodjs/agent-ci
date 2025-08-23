"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import { FormattedMessage } from "./messageFormatting";
import { ClaudeToolCard } from "./ClaudeToolCard";

interface ClaudeMessageProps {
  message: FormattedMessage;
  prevMessage?: FormattedMessage;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
}

export const ClaudeMessage = memo(function ClaudeMessage({
  message,
  prevMessage,
  autoExpandTools = false,
  showRawParameters = false,
}: ClaudeMessageProps) {
  if (!message) return null;

  // Group similar consecutive messages to reduce visual noise
  const isGrouped =
    prevMessage &&
    prevMessage.type === message.type &&
    prevMessage.type === "assistant" &&
    !prevMessage.isToolUse &&
    !message.isToolUse;

  const renderUserMessage = () => (
    <div className="flex justify-end px-4 py-2">
      <div className="max-w-[70%]">
        <div className="bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg px-4 py-2">
          <div className="text-sm whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
      </div>
    </div>
  );

  const renderAssistantMessage = () => (
    <div className="px-4 py-2">
      <div className="max-w-[85%]">
        {/* Tool Use Message */}
        {message.isToolUse && message.toolCalls && (
          <div className="space-y-2">
            {message.toolCalls.map((toolCall) => (
              <ClaudeToolCard
                key={toolCall.id}
                toolCall={toolCall}
                autoExpand={autoExpandTools}
                showRawParameters={showRawParameters}
              />
            ))}
          </div>
        )}

        {/* Regular Text Message with Markdown */}
        {message.content && !message.isToolUse && (
          <div>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown
                components={{
                  p: ({ node, ...props }) => (
                    <p className="mb-3 last:mb-0" {...props} />
                  ),
                  code: ({ node, inline, ...props }) =>
                    inline ? (
                      <code
                        className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-sm"
                        {...props}
                      />
                    ) : (
                      <code
                        className="block bg-gray-100 dark:bg-gray-800 p-3 rounded text-sm overflow-x-auto"
                        {...props}
                      />
                    ),
                  pre: ({ node, ...props }) => (
                    <pre
                      className="bg-gray-100 dark:bg-gray-800 p-3 rounded overflow-x-auto"
                      {...props}
                    />
                  ),
                  ul: ({ node, ...props }) => (
                    <ul className="list-disc list-inside mb-3" {...props} />
                  ),
                  ol: ({ node, ...props }) => (
                    <ol className="list-decimal list-inside mb-3" {...props} />
                  ),
                  li: ({ node, ...props }) => (
                    <li className="mb-1" {...props} />
                  ),
                  blockquote: ({ node, ...props }) => (
                    <blockquote
                      className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic"
                      {...props}
                    />
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {/* Combined Message with Tool Calls */}
        {message.content && message.toolCalls && (
          <>
            <div className="prose prose-sm dark:prose-invert max-w-none mb-1">
              <ReactMarkdown>{message.content}</ReactMarkdown>
            </div>
            <div className="space-y-2">
              {message.toolCalls.map((toolCall) => (
                <ClaudeToolCard
                  key={toolCall.id}
                  toolCall={toolCall}
                  autoExpand={autoExpandTools}
                  showRawParameters={showRawParameters}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );

  const renderSystemMessage = () => (
    <div className="px-4 py-1">
      <div className="flex justify-center">
        <div className="text-gray-500 dark:text-gray-400 text-xs">
          {message.content}
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={`chat-message ${message.type} ${
        isGrouped ? "grouped" : ""
      } py-2`}
    >
      {message.type === "user" && renderUserMessage()}
      {message.type === "assistant" && renderAssistantMessage()}
      {message.type === "system" && renderSystemMessage()}
    </div>
  );
});

ClaudeMessage.displayName = "ClaudeMessage";
