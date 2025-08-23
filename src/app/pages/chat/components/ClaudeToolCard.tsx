"use client";

import { useState, useEffect, useRef } from "react";
import { ToolCall } from "./messageFormatting";
import {
  FileText,
  Edit3,
  FileEdit,
  Terminal,
  CheckSquare,
  Search,
  Globe,
  Folder,
  Wrench,
  ChevronRight,
  Check,
  X,
  Notebook,
} from "lucide-react";

interface ClaudeToolCardProps {
  toolCall: ToolCall;
  autoExpand?: boolean;
  showRawParameters?: boolean;
}

export function ClaudeToolCard({
  toolCall,
  autoExpand = false,
  showRawParameters = false,
}: ClaudeToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(autoExpand);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoExpand && cardRef.current) {
      const observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && !isExpanded) {
              setIsExpanded(true);
            }
          });
        },
        { threshold: 0.1 }
      );

      observer.observe(cardRef.current);

      return () => observer.disconnect();
    }
  }, [autoExpand, isExpanded]);

  const renderToolIcon = (toolName: string) => {
    const iconProps = {
      size: 14,
      className: "text-gray-600 dark:text-gray-400",
    };

    const icons: Record<string, JSX.Element> = {
      Read: <FileText {...iconProps} />,
      Write: <FileEdit {...iconProps} />,
      Edit: <Edit3 {...iconProps} />,
      Bash: <Terminal {...iconProps} />,
      TodoWrite: <CheckSquare {...iconProps} />,
      TodoRead: <CheckSquare {...iconProps} />,
      Grep: <Search {...iconProps} />,
      Glob: <Folder {...iconProps} />,
      LS: <Folder {...iconProps} />,
      Task: <Wrench {...iconProps} />,
      WebFetch: <Globe {...iconProps} />,
      WebSearch: <Search {...iconProps} />,
      MultiEdit: <Edit3 {...iconProps} />,
      NotebookRead: <Notebook {...iconProps} />,
      NotebookEdit: <Notebook {...iconProps} />,
    };

    return icons[toolName] || <Wrench {...iconProps} />;
  };

  const renderToolInput = (toolName: string, input: any) => {
    try {
      const parsedInput = typeof input === "string" ? JSON.parse(input) : input;

      switch (toolName) {
        case "Edit":
          return renderEditInput(parsedInput);
        case "Write":
          return renderWriteInput(parsedInput);
        case "TodoWrite":
          return renderTodoWriteInput(parsedInput);
        case "Bash":
          return renderBashInput(parsedInput);
        case "Read":
          return renderReadInput(parsedInput);
        default:
          return renderGenericInput(parsedInput);
      }
    } catch (e) {
      return renderGenericInput(input);
    }
  };

  const renderEditInput = (input: any) => {
    if (input.file_path && input.old_string && input.new_string) {
      return (
        <div className="space-y-2 text-xs">
          <div className="font-mono text-gray-600 dark:text-gray-400">
            {input.file_path}
          </div>
          <div className="border-l-2 border-red-400 dark:border-red-600 pl-2">
            <pre className="text-red-600 dark:text-red-400 whitespace-pre-wrap">
              {input.old_string.substring(0, 200)}
              {input.old_string.length > 200 && "..."}
            </pre>
          </div>
          <div className="border-l-2 border-green-400 dark:border-green-600 pl-2">
            <pre className="text-green-600 dark:text-green-400 whitespace-pre-wrap">
              {input.new_string.substring(0, 200)}
              {input.new_string.length > 200 && "..."}
            </pre>
          </div>
        </div>
      );
    }
    return renderGenericInput(input);
  };

  const renderWriteInput = (input: any) => {
    if (input.file_path && input.content !== undefined) {
      return (
        <div className="space-y-2 text-xs">
          <div className="font-mono text-gray-600 dark:text-gray-400">
            {input.file_path}
          </div>
          <pre className="bg-gray-100 dark:bg-gray-800 p-2 rounded whitespace-pre-wrap max-h-32 overflow-y-auto">
            {input.content.substring(0, 500)}
            {input.content.length > 500 && "\n..."}
          </pre>
        </div>
      );
    }
    return renderGenericInput(input);
  };

  const renderTodoWriteInput = (input: any) => {
    if (input.todos && Array.isArray(input.todos)) {
      return (
        <div className="space-y-1 text-xs">
          {input.todos.slice(0, 5).map((todo: any, index: number) => (
            <div key={index} className="flex items-center gap-2">
              <div
                className={`w-1.5 h-1.5 rounded-full ${
                  todo.status === "completed"
                    ? "bg-green-500"
                    : todo.status === "in_progress"
                    ? "bg-yellow-500"
                    : "bg-gray-400"
                }`}
              />
              <span>{todo.content}</span>
            </div>
          ))}
          {input.todos.length > 5 && (
            <div className="text-gray-500 dark:text-gray-500 ml-3.5">
              +{input.todos.length - 5} more
            </div>
          )}
        </div>
      );
    }
    return renderGenericInput(input);
  };

  const renderBashInput = (input: any) => {
    if (input.command) {
      return (
        <div className="space-y-1">
          <pre className="text-xs font-mono bg-gray-100 dark:bg-gray-800 p-2 rounded overflow-x-auto">
            {input.command}
          </pre>
          {input.description && (
            <div className="text-xs text-gray-500 dark:text-gray-500">
              {input.description}
            </div>
          )}
        </div>
      );
    }
    return renderGenericInput(input);
  };

  const renderReadInput = (input: any) => {
    if (input.file_path) {
      return (
        <div className="text-xs font-mono text-gray-600 dark:text-gray-400">
          {input.file_path}
          {input.offset &&
            ` (lines ${input.offset}-${input.offset + (input.limit || 0)})`}
        </div>
      );
    }
    return renderGenericInput(input);
  };

  const renderGenericInput = (input: any) => {
    return (
      <pre className="text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded whitespace-pre-wrap break-words overflow-hidden">
        {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
      </pre>
    );
  };

  const renderToolResult = (result: { content: string; isError: boolean }) => {
    return (
      <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2 text-xs mb-1">
          {result.isError ? (
            <>
              <X size={12} className="text-red-500" />
              <span className="text-red-600 dark:text-red-400">Error</span>
            </>
          ) : (
            <>
              <Check size={12} className="text-green-500" />
              <span className="text-green-600 dark:text-green-400">
                Success
              </span>
            </>
          )}
        </div>
        <pre
          className={`text-xs whitespace-pre-wrap ${
            result.isError
              ? "text-red-600 dark:text-red-400"
              : "text-gray-600 dark:text-gray-400"
          } max-h-32 overflow-y-auto`}
        >
          {result.content.length > 500
            ? result.content.substring(0, 500) + "..."
            : result.content}
        </pre>
      </div>
    );
  };

  return (
    <div ref={cardRef} className="text-sm text-gray-600 dark:text-gray-400">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 hover:text-gray-900 dark:hover:text-gray-200 transition-colors w-full text-left"
      >
        <ChevronRight
          size={16}
          className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
        />
        {renderToolIcon(toolCall.name)}
        <span className="font-medium">{toolCall.name}</span>
        {/* Show contextual info in parentheses */}
        {(() => {
          try {
            const input =
              typeof toolCall.input === "string"
                ? JSON.parse(toolCall.input)
                : toolCall.input;

            if (toolCall.name === "Read" && input.file_path) {
              return (
                <span className="text-xs text-gray-500 dark:text-gray-500 ml-1">
                  ({input.file_path})
                </span>
              );
            }

            if (toolCall.name === "Write" && input.file_path) {
              return (
                <span className="text-xs text-gray-500 dark:text-gray-500 ml-1">
                  ({input.file_path})
                </span>
              );
            }

            if (toolCall.name === "Edit" && input.file_path) {
              return (
                <span className="text-xs text-gray-500 dark:text-gray-500 ml-1">
                  ({input.file_path})
                </span>
              );
            }

            if (toolCall.name === "Bash" && input.command) {
              const shortCommand =
                input.command.length > 40
                  ? input.command.substring(0, 40) + "..."
                  : input.command;
              return (
                <span className="text-xs text-gray-500 dark:text-gray-500 ml-1 font-mono">
                  ({shortCommand})
                </span>
              );
            }

            if (
              toolCall.name === "TodoWrite" &&
              input.todos &&
              Array.isArray(input.todos)
            ) {
              return (
                <span className="text-xs text-gray-500 dark:text-gray-500 ml-1">
                  ({input.todos.length} todo
                  {input.todos.length !== 1 ? "s" : ""})
                </span>
              );
            }

            if (toolCall.name === "Grep" && input.pattern) {
              return (
                <span className="text-xs text-gray-500 dark:text-gray-500 ml-1 font-mono">
                  (pattern: "{input.pattern}")
                </span>
              );
            }

            return null;
          } catch (e) {
            return null;
          }
        })()}
      </button>

      {isExpanded && (
        <div className="ml-6 mt-2 space-y-3">
          {renderToolInput(toolCall.name, toolCall.input)}

          {showRawParameters && (
            <details className="mt-2">
              <summary className="text-xs text-gray-500 dark:text-gray-500 cursor-pointer hover:text-gray-700 dark:hover:text-gray-300">
                View raw parameters
              </summary>
              <pre className="mt-2 text-xs bg-gray-100 dark:bg-gray-800 p-2 rounded whitespace-pre-wrap break-words overflow-hidden">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </details>
          )}

          {toolCall.result && renderToolResult(toolCall.result)}
        </div>
      )}
    </div>
  );
}
