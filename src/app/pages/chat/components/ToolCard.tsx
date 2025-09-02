"use client";

import { useState } from "react";
import { ToolCall } from "../utils/messageFormatting";
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

interface ToolCardProps {
  toolCall: ToolCall;
  autoExpand?: boolean;
}

export function ToolCard({ toolCall, autoExpand = false }: ToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(autoExpand);

  const renderToolIcon = (toolName: string) => {
    const iconProps = { size: 14, className: "text-gray-600" };

    const icons: Record<string, React.ReactElement> = {
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

  const getContextualInfo = () => {
    try {
      const input =
        typeof toolCall.input === "string"
          ? JSON.parse(toolCall.input)
          : toolCall.input;

      if (toolCall.name === "Read" && input.file_path) {
        return `(${input.file_path})`;
      }

      if (toolCall.name === "Write" && input.file_path) {
        return `(${input.file_path})`;
      }

      if (toolCall.name === "Edit" && input.file_path) {
        return `(${input.file_path})`;
      }

      if (toolCall.name === "Bash" && input.command) {
        const shortCommand =
          input.command.length > 40
            ? input.command.substring(0, 40) + "..."
            : input.command;
        return `(${shortCommand})`;
      }

      if (
        toolCall.name === "TodoWrite" &&
        input.todos &&
        Array.isArray(input.todos)
      ) {
        return `(${input.todos.length} todo${input.todos.length !== 1 ? "s" : ""})`;
      }

      if (toolCall.name === "Grep" && input.pattern) {
        return `(pattern: "${input.pattern}")`;
      }

      return null;
    } catch (e) {
      return null;
    }
  };

  const renderToolParameters = () => {
    try {
      const input =
        typeof toolCall.input === "string"
          ? JSON.parse(toolCall.input)
          : toolCall.input;

      switch (toolCall.name) {
        case "Edit":
          return renderEditInput(input);
        case "Write":
          return renderWriteInput(input);
        case "TodoWrite":
          return renderTodoWriteInput(input);
        case "Bash":
          return renderBashInput(input);
        case "Read":
          return renderReadInput(input);
        default:
          return renderGenericInput(input);
      }
    } catch (e) {
      return renderGenericInput(toolCall.input);
    }
  };

  const renderEditInput = (input: any) => {
    if (input.file_path && input.old_string && input.new_string) {
      return (
        <div className="space-y-2 text-xs">
          <div className="font-mono text-gray-600">{input.file_path}</div>
          <div className="border-l-2 border-red-400 pl-3">
            <div className="text-red-600 font-medium mb-1">- Remove:</div>
            <pre className="text-red-600 whitespace-pre-wrap bg-red-50 p-2 rounded">
              {input.old_string.substring(0, 200)}
              {input.old_string.length > 200 && "..."}
            </pre>
          </div>
          <div className="border-l-2 border-green-400 pl-3">
            <div className="text-green-600 font-medium mb-1">+ Add:</div>
            <pre className="text-green-600 whitespace-pre-wrap bg-green-50 p-2 rounded">
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
          <div className="font-mono text-gray-600">{input.file_path}</div>
          <pre className="bg-white p-3 rounded border whitespace-pre-wrap max-h-32 overflow-y-auto">
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
              <span className="text-gray-700">{todo.content}</span>
            </div>
          ))}
          {input.todos.length > 5 && (
            <div className="text-gray-500 ml-3.5">
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
        <div className="space-y-2">
          <pre className="text-xs font-mono bg-gray-900 text-green-400 p-3 rounded overflow-x-auto">
            $ {input.command}
          </pre>
          {input.description && (
            <div className="text-xs text-gray-600">{input.description}</div>
          )}
        </div>
      );
    }
    return renderGenericInput(input);
  };

  const renderReadInput = (input: any) => {
    if (input.file_path) {
      return (
        <div className="text-xs">
          <div className="font-mono text-gray-600">
            {input.file_path}
            {input.offset &&
              ` (lines ${input.offset}-${input.offset + (input.limit || 0)})`}
          </div>
        </div>
      );
    }
    return renderGenericInput(input);
  };

  const renderGenericInput = (input: any) => {
    return (
      <pre className="text-xs bg-white p-3 rounded border whitespace-pre-wrap">
        {typeof input === "string" ? input : JSON.stringify(input, null, 2)}
      </pre>
    );
  };

  const renderToolResult = (result: { content: string; isError: boolean }) => {
    return (
      <div className="mt-3 pt-3 border-t border-gray-200">
        <div className="flex items-center gap-2 text-xs mb-2">
          {result.isError ? (
            <>
              <X size={12} className="text-red-500" />
              <span className="text-red-600">Error</span>
            </>
          ) : (
            <>
              <Check size={12} className="text-green-500" />
              <span className="text-green-600">Success</span>
            </>
          )}
        </div>
        <pre
          className={`text-xs whitespace-pre-wrap max-h-32 overflow-y-auto ${
            result.isError ? "text-red-600" : "text-gray-600"
          }`}
        >
          {result.content.length > 500
            ? result.content.substring(0, 500) + "..."
            : result.content}
        </pre>
      </div>
    );
  };

  return (
    <div className="border border-gray-200 rounded-lg bg-gray-50 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 p-3 hover:bg-gray-100 transition-colors text-left"
      >
        <ChevronRight
          size={16}
          className={`transition-transform text-gray-500 ${isExpanded ? "rotate-90" : ""}`}
        />
        {renderToolIcon(toolCall.name)}
        <span className="font-medium text-sm text-gray-700">
          {toolCall.name}
        </span>
        {getContextualInfo() && (
          <span className="text-xs text-gray-500 font-mono">
            {getContextualInfo()}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="px-3 pb-3">
          <div className="ml-6 space-y-3">
            {/* Tool parameters */}
            {renderToolParameters()}

            {toolCall.result && renderToolResult(toolCall.result)}
          </div>
        </div>
      )}
    </div>
  );
}

