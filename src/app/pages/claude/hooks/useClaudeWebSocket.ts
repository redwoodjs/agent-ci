import { useState, useEffect, useRef } from "react";

interface AuthStatus {
  authenticated: boolean;
  expires_at?: number;
}

interface ClaudeMessage {
  type: string;
  session_id?: string;
  message?: {
    content?: any;
  };
  subtype?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
}

interface ExitMessage {
  type: "exit";
  exitCode: number | { exitCode: number };
  message: string;
}

const WS_CONFIG = {
  MAX_RETRIES: 3,
  CONTAINER_PORT: 8911,
  RETRY_DELAY_BASE_MS: 1000,
} as const;

export function useClaudeWebSocket() {
  const [output, setOutput] = useState<string[]>([]);
  const [conversationMode, setConversationMode] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    checkAuthStatus();
  }, []);

  useEffect(() => {
    // Cleanup WebSocket on unmount
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  const checkAuthStatus = async () => {
    try {
      const response = await fetch("/api/auth/status");
      const status: AuthStatus = await response.json();
      setAuthenticated(status.authenticated);
    } catch (err) {
      setError("Failed to check authentication status");
    }
  };

  const appendOutput = (text: string) => {
    setOutput((prev) => [...prev, text]);
  };

  const clearOutput = () => {
    setOutput([]);
    setError("");
  };

  const executeClaudeQuery = async (query: string) => {
    if (!query.trim()) return;

    setLoading(true);
    setError("");

    try {
      const command = conversationMode
        ? `claude --continue --output-format stream-json --verbose --print "${query.replace(/"/g, '\\"')}"`
        : `claude --output-format stream-json --verbose --print "${query.replace(/"/g, '\\"')}"`;

      // Clear previous output for new queries
      setOutput([
        `> ${command.replace(" --output-format stream-json --verbose", "")}`,
      ]); // Hide the JSON flags from display

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

      // Connect to WebSocket immediately for real-time streaming
      connectToWebSocket(processId);
    } catch (err) {
      setError(
        `Failed to execute Claude query: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
      setLoading(false);
    }
  };

  const connectToWebSocket = (processId: string, retryCount = 0) => {
    const RETRY_DELAY_MS = WS_CONFIG.RETRY_DELAY_BASE_MS * (retryCount + 1); // Progressive delay: 1s, 2s, 3s

    // Close existing WebSocket if any
    if (wsRef.current) {
      wsRef.current.close();
    }

    // Track what we've already processed to avoid duplicates
    const seenMessages = new Set<string>();
    let hasInit = false;
    let buffer = "";

    // Determine WebSocket URL - connect directly to container port for WebSocket
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//localhost:${WS_CONFIG.CONTAINER_PORT}/tty/output?processId=${processId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      appendOutput("\n🔌 Connected to Claude stream...");
    };

    const handleExitMessage = (message: ExitMessage) => {
      const exitCode =
        typeof message.exitCode === "object"
          ? message.exitCode?.exitCode || 0
          : message.exitCode || 0;
      appendOutput(`\n[Process completed with code ${exitCode}]`);
      setLoading(false);
      // Don't trigger reconnection for normal exit
      wsRef.current = null;
    };

    ws.onmessage = (event) => {
      const data = event.data;

      // Check if this is a control message (exit notification)
      try {
        const jsonMessage = JSON.parse(data) as ExitMessage;
        if (jsonMessage.type === "exit") {
          handleExitMessage(jsonMessage);
          return;
        }
      } catch {
        // Not a control message, process as streaming data
      }

      // Add to buffer and process line by line
      buffer += data;

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const jsonMessage = JSON.parse(line) as ClaudeMessage;

          // Create unique identifier for this message to avoid duplicates
          const messageId = `${jsonMessage.type}-${jsonMessage.session_id}-${JSON.stringify(jsonMessage.message?.content || "")}-${jsonMessage.subtype || ""}`;

          if (seenMessages.has(messageId)) {
            continue; // Skip duplicates
          }
          seenMessages.add(messageId);

          if (
            jsonMessage.type === "system" &&
            jsonMessage.subtype === "init" &&
            !hasInit
          ) {
            appendOutput("\n🤖 Starting Claude...");
            hasInit = true;
          } else if (jsonMessage.type === "user") {
            // User message - handle both regular messages and tool results
            if (jsonMessage.message?.content) {
              let processed = false;

              if (Array.isArray(jsonMessage.message.content)) {
                for (const contentItem of jsonMessage.message.content) {
                  if (contentItem.type === "tool_result") {
                    // This is a tool result being sent back to Claude
                    if (contentItem.is_error) {
                      appendOutput(`\n❌ Error: ${contentItem.content}`);
                    } else if (
                      contentItem.content &&
                      contentItem.content.includes("→")
                    ) {
                      // File content with line numbers - show preview
                      const lines = contentItem.content.split("\n").slice(0, 5);
                      appendOutput(
                        `\n📄 File content preview:\n${lines.join("\n")}${contentItem.content.split("\n").length > 5 ? "\n   ..." : ""}`,
                      );
                    } else if (
                      contentItem.content &&
                      contentItem.content.includes("has been updated")
                    ) {
                      // Edit success message
                      appendOutput(`\n✅ File updated successfully`);
                    } else {
                      // Other tool results - show abbreviated
                      const preview =
                        contentItem.content?.substring(0, 100) || "";
                      appendOutput(
                        `\n📤 ${preview}${contentItem.content?.length > 100 ? "..." : ""}`,
                      );
                    }
                    processed = true;
                  } else if (contentItem.text) {
                    appendOutput(`\n👤 ${contentItem.text}`);
                    processed = true;
                  }
                }
              }

              // Fallback for other content types
              if (
                !processed &&
                typeof jsonMessage.message.content === "string"
              ) {
                appendOutput(`\n👤 ${jsonMessage.message.content}`);
              }
            }
          } else if (jsonMessage.type === "assistant") {
            // Assistant message - this contains the actual tool calls and responses
            const msg = jsonMessage.message;

            if (msg?.content && Array.isArray(msg.content)) {
              // Handle content array (text and tool calls)
              for (const contentItem of msg.content) {
                if (contentItem.type === "text" && contentItem.text) {
                  appendOutput(`\n💭 ${contentItem.text}`);
                } else if (contentItem.type === "tool_use") {
                  appendOutput(`\n🔧 ${contentItem.name}`);

                  // Show key arguments only
                  if (contentItem.input) {
                    if (contentItem.input.file_path) {
                      appendOutput(` → ${contentItem.input.file_path}`);
                    }
                    if (contentItem.input.command) {
                      appendOutput(
                        ` → ${contentItem.input.command.substring(0, 50)}${contentItem.input.command.length > 50 ? "..." : ""}`,
                      );
                    }
                    if (
                      contentItem.input.old_string &&
                      contentItem.input.new_string
                    ) {
                      // For edits, just show we're making changes
                      appendOutput(` → Making edits...`);
                    }
                  }
                }
              }
            }
          } else if (jsonMessage.type === "result") {
            // Final result with stats
            appendOutput(`\n\n✅ ${jsonMessage.result}`);
            if (!jsonMessage.is_error) {
              appendOutput(
                `\n💰 $${jsonMessage.total_cost_usd || 0} • ⏱️ ${Math.round((jsonMessage.duration_ms || 0) / 1000)}s • 🔄 ${jsonMessage.num_turns || 0} turns`,
              );
            }
            setLoading(false);
            // Mark as completed to prevent error on close
            wsRef.current = null;
            ws.close();
          }
        } catch {
          // Not JSON, might be raw output - add directly
          if (!seenMessages.has(line)) {
            seenMessages.add(line);
            appendOutput("\n" + line);
          }
        }
      }
    };

    ws.onerror = () => {
      if (retryCount < WS_CONFIG.MAX_RETRIES) {
        setTimeout(() => {
          connectToWebSocket(processId, retryCount + 1);
        }, RETRY_DELAY_MS);
      } else {
        setError("WebSocket connection failed after multiple retries");
        setLoading(false);
      }
    };

    ws.onclose = (event) => {
      // Check if we already cleared the ref (normal exit)
      if (wsRef.current === null) {
        return;
      }

      const isNormalClose = event.code === 1000 || event.code === 1001;

      if (isNormalClose) {
        setLoading(false);
      } else if (retryCount < WS_CONFIG.MAX_RETRIES) {
        // Unexpected close - retry
        appendOutput(
          `\n🔄 Connection lost, retrying... (${retryCount + 1}/${WS_CONFIG.MAX_RETRIES + 1})`,
        );
        setTimeout(() => {
          connectToWebSocket(processId, retryCount + 1);
        }, RETRY_DELAY_MS);
      } else {
        // Max retries exceeded
        setError(
          `WebSocket connection failed after ${WS_CONFIG.MAX_RETRIES + 1} attempts (final code: ${event.code})`,
        );
        setLoading(false);
      }

      wsRef.current = null;
    };
  };

  return {
    output,
    conversationMode,
    setConversationMode,
    authenticated,
    loading,
    error,
    executeClaudeQuery,
    clearOutput,
    checkAuthStatus,
  };
}