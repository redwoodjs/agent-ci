"use client";

import { useState, useEffect, useRef } from "react";

interface AuthStatus {
  authenticated: boolean;
  expires_at?: number;
}

export function ClaudePanel() {
  const [query, setQuery] = useState("");
  const [output, setOutput] = useState<string[]>([]);
  const [conversationMode, setConversationMode] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  
  const outputRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    checkAuthStatus();
  }, []);

  useEffect(() => {
    // Auto-scroll to bottom when output changes
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const checkAuthStatus = async () => {
    try {
      const response = await fetch("/api/auth/status");
      const status: AuthStatus = await response.json();
      setAuthenticated(status.authenticated);
    } catch (err) {
      console.error("Failed to check auth status:", err);
      setError("Failed to check authentication status");
    }
  };

  const appendOutput = (text: string) => {
    setOutput(prev => [...prev, text]);
  };

  const executeClaudeQuery = async () => {
    if (!query.trim()) return;
    
    setLoading(true);
    setError("");
    
    try {
      const command = conversationMode 
        ? `claude --continue --output-format stream-json --verbose --print "${query.replace(/"/g, '\\"')}"`
        : `claude --output-format stream-json --verbose --print "${query.replace(/"/g, '\\"')}"`;
        
      // Clear previous output for new queries
      setOutput([`> ${command.replace(' --output-format stream-json --verbose', '')}`]); // Hide the JSON flags from display
      
      // Execute command via new TTY exec endpoint
      const response = await fetch("/sandbox/tty/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      const processId = data.processId;
      
      // Poll for output instead of WebSocket (simpler approach)
      pollForOutput(processId);
      
    } catch (err) {
      setError(`Failed to execute Claude query: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setLoading(false);
    }
  };

  const pollForOutput = async (processId: string) => {
    console.log('Starting to poll for output:', processId);
    
    // Track what we've already processed to avoid duplicates
    const seenMessages = new Set();
    let hasInit = false;
    
    // Poll every 1 second for up to 60 seconds
    const maxAttempts = 60;
    let attempts = 0;
    
    const poll = async () => {
      try {
        const response = await fetch(`/sandbox/tty/status?processId=${processId}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.output) {
          // Parse streaming JSON output
          const lines = data.output.trim().split('\n');
          let hasProcessedResults = false;
          
          for (const line of lines) {
            if (!line.trim()) continue;
            
            try {
              const jsonMessage = JSON.parse(line);
              
              // Create unique identifier for this message to avoid duplicates
              const messageId = `${jsonMessage.type}-${jsonMessage.session_id}-${JSON.stringify(jsonMessage.message?.content || '')}-${jsonMessage.subtype || ''}`;
              
              if (seenMessages.has(messageId)) {
                continue; // Skip duplicates
              }
              seenMessages.add(messageId);
              
              if (jsonMessage.type === 'system' && jsonMessage.subtype === 'init' && !hasInit) {
                appendOutput('\n🤖 Starting Claude...');
                hasInit = true;
              } else if (jsonMessage.type === 'user') {
                // User message - handle both regular messages and tool results
                if (jsonMessage.message?.content) {
                  let processed = false;
                  
                  if (Array.isArray(jsonMessage.message.content)) {
                    for (const contentItem of jsonMessage.message.content) {
                      if (contentItem.type === 'tool_result') {
                        // This is a tool result being sent back to Claude
                        if (contentItem.is_error) {
                          appendOutput(`\n❌ Error: ${contentItem.content}`);
                        } else if (contentItem.content && contentItem.content.includes('→')) {
                          // File content with line numbers - show preview
                          const lines = contentItem.content.split('\n').slice(0, 5);
                          appendOutput(`\n📄 File content preview:\n${lines.join('\n')}${contentItem.content.split('\n').length > 5 ? '\n   ...' : ''}`);
                        } else if (contentItem.content && contentItem.content.includes('has been updated')) {
                          // Edit success message
                          appendOutput(`\n✅ File updated successfully`);
                        } else {
                          // Other tool results - show abbreviated
                          const preview = contentItem.content?.substring(0, 100) || '';
                          appendOutput(`\n📤 ${preview}${contentItem.content?.length > 100 ? '...' : ''}`);
                        }
                        processed = true;
                      } else if (contentItem.text) {
                        appendOutput(`\n👤 ${contentItem.text}`);
                        processed = true;
                      }
                    }
                  }
                  
                  // Fallback for other content types
                  if (!processed && typeof jsonMessage.message.content === 'string') {
                    appendOutput(`\n👤 ${jsonMessage.message.content}`);
                  }
                }
              } else if (jsonMessage.type === 'assistant') {
                // Assistant message - this contains the actual tool calls and responses
                const msg = jsonMessage.message;
                
                if (msg?.content && Array.isArray(msg.content)) {
                  // Handle content array (text and tool calls)
                  for (const contentItem of msg.content) {
                    if (contentItem.type === 'text' && contentItem.text) {
                      appendOutput(`\n💭 ${contentItem.text}`);
                    } else if (contentItem.type === 'tool_use') {
                      appendOutput(`\n🔧 ${contentItem.name}`);
                      
                      // Show key arguments only
                      if (contentItem.input) {
                        if (contentItem.input.file_path) {
                          appendOutput(` → ${contentItem.input.file_path}`);
                        }
                        if (contentItem.input.command) {
                          appendOutput(` → ${contentItem.input.command.substring(0, 50)}${contentItem.input.command.length > 50 ? '...' : ''}`);
                        }
                        if (contentItem.input.old_string && contentItem.input.new_string) {
                          // For edits, just show we're making changes
                          appendOutput(` → Making edits...`);
                        }
                      }
                    }
                  }
                }
              } else if (jsonMessage.type === 'result') {
                // Final result with stats
                appendOutput(`\n\n✅ ${jsonMessage.result}`);
                if (!jsonMessage.is_error) {
                  appendOutput(`\n💰 $${jsonMessage.total_cost_usd || 0} • ⏱️ ${Math.round((jsonMessage.duration_ms || 0) / 1000)}s • 🔄 ${jsonMessage.num_turns || 0} turns`);
                }
                hasProcessedResults = true;
                setLoading(false);
                console.log('Claude finished - received result message, stopping poll');
              }
            } catch {
              // Not JSON, might be raw output - only show if we haven't processed results yet
              if (!hasProcessedResults && !seenMessages.has(line)) {
                seenMessages.add(line);
                appendOutput('\n' + line);
              }
            }
          }
          
          if (hasProcessedResults) {
            console.log('Stopping poll - result has been processed');
            return;
          }
        }
        
        if (data.finished) {
          console.log('Stopping poll - process finished');
          appendOutput(`\n[Process completed]`);
          setLoading(false);
          return;
        }
        
        // Continue polling if not finished (longer delay for less aggressive polling)
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(poll, 1000); // Poll every 1 second instead of 500ms
        } else {
          setError('Timeout waiting for Claude response');
          setLoading(false);
        }
        
      } catch (err) {
        console.error('Poll error:', err);
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(poll, 1000); // Poll every 1 second
        } else {
          setError('Failed to get Claude response');
          setLoading(false);
        }
      }
    };
    
    // Start polling after a short delay
    setTimeout(poll, 100);
  };

  const clearOutput = () => {
    setOutput([]);
    setError("");
  };

  const quickActions = [
    { label: "Explain this file", action: () => setQuery("Explain this file") },
    { label: "Review code", action: () => setQuery("Review this code for potential issues") },
    { label: "Add tests", action: () => setQuery("Add unit tests for this code") },
    { label: "Refactor", action: () => setQuery("Suggest refactoring improvements") },
  ];

  if (!authenticated) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-900 text-white p-4">
        <div className="text-center">
          <h3 className="text-lg font-semibold mb-2">Claude Authentication Required</h3>
          <p className="text-gray-400 mb-4">Please authenticate with Claude on the home page first.</p>
          <button 
            onClick={() => window.location.href = '/'}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded"
          >
            Go to Authentication
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-900 text-white">
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
              onClick={clearOutput}
              className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded"
            >
              Clear
            </button>
          </div>
        </div>
        
        {/* Quick Actions */}
        <div className="flex flex-wrap gap-1 mb-2">
          {quickActions.map((action, index) => (
            <button
              key={index}
              onClick={action.action}
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
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                executeClaudeQuery();
              }
            }}
            placeholder="Ask Claude anything..."
            className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded text-white placeholder-gray-400 focus:outline-none focus:border-blue-500"
            disabled={loading}
          />
          <button
            onClick={executeClaudeQuery}
            disabled={loading || !query.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded font-medium"
          >
            {loading ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}