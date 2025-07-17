"use client";

import { useState, useEffect, useRef } from "react";

const QUICK_ACTIONS = [
  { label: "Explain this file", action: "Explain this file" },
  { label: "Review code", action: "Review this code for potential issues" },
  { label: "Add tests", action: "Add unit tests for this code" },
  { label: "Refactor", action: "Suggest refactoring improvements" },
] as const;

interface ClaudeLayoutProps {
  output: string[];
  loading: boolean;
  error: string;
  conversationMode: boolean;
  setConversationMode: (mode: boolean) => void;
  onExecuteQuery: (query: string) => void;
  onClearOutput: () => void;
}

export function ClaudeLayout({
  output,
  loading,
  error,
  conversationMode,
  setConversationMode,
  onExecuteQuery,
  onClearOutput,
}: ClaudeLayoutProps) {
  const [query, setQuery] = useState("");
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto-scroll to bottom when output changes
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleSubmit = () => {
    if (query.trim()) {
      onExecuteQuery(query);
      setQuery("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="h-screen flex bg-gray-900 text-white">
      {/* Sidebar */}
      <div className="w-80 flex-shrink-0 bg-gray-800 border-r border-gray-700 flex flex-col">
        <div className="p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold">Claude Sessions</h2>
        </div>
        
        <div className="flex-1 p-4">
          <button className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded font-medium">
            New Session
          </button>
          
          <div className="mt-4 text-sm text-gray-400">
            <p>Session history will be available in Phase 4</p>
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="p-3 border-b border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-semibold">Claude Code</h3>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={conversationMode}
                  onChange={(e) => setConversationMode(e.target.checked)}
                  className="w-4 h-4"
                />
                Continue conversation
              </label>
              <button
                onClick={onClearOutput}
                className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="flex flex-wrap gap-1 mb-2">
            {QUICK_ACTIONS.map((action, index) => (
              <button
                key={index}
                onClick={() => setQuery(action.action)}
                className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded"
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>

        {/* Output Area */}
        <div
          ref={outputRef}
          className="flex-1 p-3 overflow-y-auto font-mono text-sm bg-black"
        >
          {output.length === 0 ? (
            <div className="text-gray-500 italic">
              Enter a query below to start chatting with Claude...
            </div>
          ) : (
            output.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-words">
                {line}
              </div>
            ))
          )}
          {loading && (
            <div className="text-yellow-400 animate-pulse">
              🧠 Claude is processing your request...
            </div>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <div className="p-2 bg-red-900 border-t border-red-700 text-red-200 text-sm">
            Error: {error}
          </div>
        )}

        {/* Input Area */}
        <div className="p-3 border-t border-gray-700">
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Claude anything..."
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
              disabled={loading}
            />
            <button
              onClick={handleSubmit}
              disabled={loading || !query.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium"
            >
              {loading ? "..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}