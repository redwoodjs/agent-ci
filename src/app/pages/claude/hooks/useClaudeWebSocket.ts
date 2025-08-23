import { useState, useEffect, useRef } from "react";
import {
  FormattedMessage,
  MessageFormatter,
} from "../../chat/components/messageFormatting";
import type {
  ClaudeMessage,
  ExitMessage,
} from "../../chat/components/messageFormatting";

interface AuthStatus {
  authenticated: boolean;
  expires_at?: number;
}

const WS_CONFIG = {
  MAX_RETRIES: 3,
  CONTAINER_PORT: 8911,
  RETRY_DELAY_BASE_MS: 1000,
} as const;

export function useClaudeWebSocket(containerId: string) {
  const [messages, setMessages] = useState<FormattedMessage[]>([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const messageFormatterRef = useRef<MessageFormatter>(new MessageFormatter());

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

      // If authenticated, ensure credentials are set up in container
      if (status.authenticated && status.expires_at) {
        await setupContainerCredentials(status.expires_at);
      }
    } catch (err) {
      setError("Failed to check authentication status");
    }
  };

  const setupContainerCredentials = async (expiresAt: number) => {
    try {
      // Send credentials to the specific container using the new endpoint
      const credentialsResponse = await fetch(
        `/api/containers/${containerId}/setup-credentials`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );

      if (!credentialsResponse.ok) {
        const error = await credentialsResponse.json();
        throw new Error(
          error.details || "Failed to set up container credentials"
        );
      }

      const result = await credentialsResponse.json();
      console.log("Container credentials set up successfully:", result);
    } catch (err) {
      console.warn("Failed to set up container credentials:", err);
      // Don't set error state as this might not be critical for all operations
    }
  };

  const addMessage = (message: FormattedMessage) => {
    setMessages((prev) => [...prev, message]);
  };

  const clearMessages = () => {
    setMessages([]);
    setError("");
    messageFormatterRef.current = new MessageFormatter();
  };

  const executeClaudeQuery = async (query: string) => {
    if (!query.trim()) return;

    setLoading(true);
    setError("");

    try {
      const command = `claude --continue --model sonnet --output-format stream-json --verbose --print "${query.replace(
        /"/g,
        '\\"'
      )}"`;

      // Messages are never cleared automatically - user must click Clear button

      // Add user message
      addMessage({
        id: `user-${Date.now()}`,
        type: "user",
        content: query,
        timestamp: new Date().toISOString(),
      });

      // Execute command via container-specific TTY exec endpoint
      const response = await fetch(`/api/containers/${containerId}/tty/exec`, {
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
        `Failed to execute Claude query: ${
          err instanceof Error ? err.message : "Unknown error"
        }`
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

    // Determine WebSocket URL - use container-specific routing
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/containers/${containerId}/tty/output?processId=${processId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      addMessage(
        messageFormatterRef.current.createConnectionMessage("connected")
      );
    };

    const handleExitMessage = (message: ExitMessage) => {
      const exitCode =
        typeof message.exitCode === "object"
          ? message.exitCode?.exitCode || 0
          : message.exitCode || 0;
      addMessage(
        messageFormatterRef.current.createSystemMessage(
          `[Process completed with code ${exitCode}]`
        )
      );
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
          const messageId = `${jsonMessage.type}-${
            jsonMessage.session_id
          }-${JSON.stringify(jsonMessage.message?.content || "")}-${
            jsonMessage.subtype || ""
          }`;

          if (seenMessages.has(messageId)) {
            continue; // Skip duplicates
          }
          seenMessages.add(messageId);

          // Use MessageFormatter to convert to structured message
          const formattedMessage =
            messageFormatterRef.current.formatMessage(jsonMessage);
          if (formattedMessage) {
            addMessage(formattedMessage);
          }

          // Handle special cases
          if (jsonMessage.type === "result") {
            setLoading(false);
            // Mark as completed to prevent error on close
            wsRef.current = null;
            ws.close();
          }
        } catch {
          // Not JSON, might be raw output - add directly
          if (!seenMessages.has(line)) {
            seenMessages.add(line);
            addMessage(messageFormatterRef.current.createSystemMessage(line));
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
        addMessage(
          messageFormatterRef.current.createConnectionMessage(
            "connecting",
            `Connection lost, retrying... (${retryCount + 1}/${
              WS_CONFIG.MAX_RETRIES + 1
            })`
          )
        );
        setTimeout(() => {
          connectToWebSocket(processId, retryCount + 1);
        }, RETRY_DELAY_MS);
      } else {
        // Max retries exceeded
        setError(
          `WebSocket connection failed after ${
            WS_CONFIG.MAX_RETRIES + 1
          } attempts (final code: ${event.code})`
        );
        setLoading(false);
      }

      wsRef.current = null;
    };
  };

  return {
    messages,
    authenticated,
    loading,
    error,
    executeClaudeQuery,
    clearMessages,
    checkAuthStatus,
  };
}
