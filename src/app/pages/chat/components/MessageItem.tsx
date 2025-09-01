"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import { FormattedMessage } from "../utils/messageFormatting";
import { ToolCard } from "./ToolCard";

interface MessageItemProps {
  message: FormattedMessage;
  prevMessage?: FormattedMessage;
}

export const MessageItem = memo(function MessageItem({
  message,
  prevMessage,
}: MessageItemProps) {
  const renderUserMessage = () => (
    <div className="flex justify-end">
      <div className="max-w-xs lg:max-w-md">
        <div className="bg-blue-500 text-white rounded-lg px-4 py-2">
          <div className="text-sm whitespace-pre-wrap break-words">
            {message.content}
          </div>
          <div className="text-xs mt-1 opacity-70">
            {new Date(message.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    </div>
  );

  const renderAssistantMessage = () => (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        {/* Tool Use Message */}
        {message.isToolUse && message.toolCalls && (
          <div className="space-y-2">
            {message.toolCalls.map((toolCall) => (
              <ToolCard key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        )}

        {/* Regular Text Message with Markdown */}
        {message.content && !message.isToolUse && (
          <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
            <div className="prose prose-sm max-w-none">
              <ReactMarkdown
                components={{
                  p: ({ node, ...props }) => (
                    <p className="mb-3 last:mb-0" {...props} />
                  ),
                  code: ({ node, ...props }) => (
                    <code
                      className="bg-gray-100 px-1 py-0.5 rounded text-sm"
                      {...props}
                    />
                  ),
                  pre: ({ node, ...props }) => (
                    <pre
                      className="bg-gray-100 p-3 rounded overflow-x-auto"
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
                      className="border-l-4 border-gray-300 pl-4 italic"
                      {...props}
                    />
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
            <div className="text-xs text-gray-500 mt-2">
              {new Date(message.timestamp).toLocaleTimeString()}
            </div>
          </div>
        )}

        {/* Combined Message with Tool Calls */}
        {message.content && message.toolCalls && (
          <div className="space-y-3">
            <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
              <div className="prose prose-sm max-w-none">
                <ReactMarkdown
                  components={{
                    p: ({ node, ...props }) => (
                      <p className="mb-3 last:mb-0" {...props} />
                    ),
                    code: ({ node, ...props }) => (
                      <code
                        className="bg-gray-100 px-1 py-0.5 rounded text-sm"
                        {...props}
                      />
                    ),
                  }}
                >
                  {message.content}
                </ReactMarkdown>
              </div>
              <div className="text-xs text-gray-500 mt-2">
                {new Date(message.timestamp).toLocaleTimeString()}
              </div>
            </div>
            <div className="space-y-2">
              {message.toolCalls.map((toolCall) => (
                <ToolCard key={toolCall.id} toolCall={toolCall} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const renderSystemMessage = () => (
    <div className="flex justify-center">
      <div className="text-gray-500 text-xs bg-gray-100 px-3 py-1 rounded-full">
        {message.content}
      </div>
    </div>
  );

  return (
    <div className="py-2">
      {message.type === "user" && renderUserMessage()}
      {message.type === "assistant" && renderAssistantMessage()}
      {message.type === "system" && renderSystemMessage()}
    </div>
  );
});

MessageItem.displayName = "MessageItem";

