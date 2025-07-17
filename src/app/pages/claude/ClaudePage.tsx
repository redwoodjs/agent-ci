"use client";

import { useClaudeWebSocket } from "./hooks/useClaudeWebSocket";
import { ClaudeLayout } from "./components/ClaudeLayout";

export function ClaudePage() {
  const {
    output,
    conversationMode,
    setConversationMode,
    authenticated,
    loading,
    error,
    executeClaudeQuery,
    clearOutput,
  } = useClaudeWebSocket();

  if (!authenticated) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-900 text-white p-4">
        <div className="text-center">
          <h3 className="text-lg font-semibold mb-2">
            Claude Authentication Required
          </h3>
          <p className="text-gray-400 mb-4">
            Please authenticate with Claude on the home page first.
          </p>
          <button
            onClick={() => (window.location.href = "/")}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded"
          >
            Go to Authentication
          </button>
        </div>
      </div>
    );
  }

  return (
    <ClaudeLayout
      output={output}
      loading={loading}
      error={error}
      conversationMode={conversationMode}
      setConversationMode={setConversationMode}
      onExecuteQuery={executeClaudeQuery}
      onClearOutput={clearOutput}
    />
  );
}