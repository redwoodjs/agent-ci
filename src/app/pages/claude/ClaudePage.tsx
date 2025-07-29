"use client";

import { useState, useEffect } from "react";
import { useClaudeWebSocket } from "./hooks/useClaudeWebSocket";
import { ClaudeLayout } from "./components/ClaudeLayout";

export function ClaudePage({ params }: { params: { containerId: string } }) {
  const containerId = params.containerId;
  
  const {
    messages,
    authenticated,
    loading,
    error,
    executeClaudeQuery,
    clearMessages,
  } = useClaudeWebSocket(containerId);
  
  // Settings for tool display - initialize safely for SSR
  const [autoExpandTools, setAutoExpandTools] = useState(false);
  const [showRawParameters, setShowRawParameters] = useState(false);
  
  // Load settings from localStorage on client side only
  useEffect(() => {
    const savedAutoExpand = localStorage.getItem('autoExpandTools');
    if (savedAutoExpand !== null) {
      setAutoExpandTools(JSON.parse(savedAutoExpand));
    }
    
    const savedShowRaw = localStorage.getItem('showRawParameters');
    if (savedShowRaw !== null) {
      setShowRawParameters(JSON.parse(savedShowRaw));
    }
  }, []);

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
      containerId={containerId}
      messages={messages}
      loading={loading}
      error={error}
      onExecuteQuery={executeClaudeQuery}
      onClearMessages={clearMessages}
      autoExpandTools={autoExpandTools}
      showRawParameters={showRawParameters}
    />
  );
}