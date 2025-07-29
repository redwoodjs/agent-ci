export interface ToolCall {
  id: string;
  name: string;
  input: any;
  result?: {
    content: string;
    isError: boolean;
  };
}

export interface FormattedMessage {
  id: string;
  type: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  isToolUse?: boolean;
  toolCalls?: ToolCall[];
}

export interface ClaudeMessage {
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

export interface ExitMessage {
  type: "exit";
  exitCode: number | { exitCode: number };
  message: string;
}

export class MessageFormatter {
  private messageCounter = 0;
  private activeToolCalls = new Map<string, ToolCall>();
  
  formatMessage(rawMessage: ClaudeMessage): FormattedMessage | null {
    const timestamp = new Date().toISOString();
    const messageId = `msg-${++this.messageCounter}`;
    
    switch (rawMessage.type) {
      case "system":
        if (rawMessage.subtype === "init") {
          return {
            id: messageId,
            type: "system",
            content: "Starting Claude...",
            timestamp,
          };
        }
        break;
        
      case "user":
        return this.formatUserMessage(rawMessage, messageId, timestamp);
        
      case "assistant":
        return this.formatAssistantMessage(rawMessage, messageId, timestamp);
        
      case "result":
        return {
          id: messageId,
          type: "system",
          content: `$${rawMessage.total_cost_usd || 0} • ${Math.round((rawMessage.duration_ms || 0) / 1000)}s • ${rawMessage.num_turns || 0} turns`,
          timestamp,
        };
        
      default:
        return null;
    }
    
    return null;
  }
  
  private formatUserMessage(rawMessage: ClaudeMessage, messageId: string, timestamp: string): FormattedMessage | null {
    if (!rawMessage.message?.content) return null;
    
    let content = "";
    const toolResults: ToolCall[] = [];
    
    if (Array.isArray(rawMessage.message.content)) {
      for (const contentItem of rawMessage.message.content) {
        if (contentItem.type === "tool_result") {
          // Update existing tool call with result
          const toolCall = this.activeToolCalls.get(contentItem.tool_use_id);
          if (toolCall) {
            toolCall.result = {
              content: contentItem.content,
              isError: contentItem.is_error,
            };
            toolResults.push(toolCall);
          }
        } else if (contentItem.text) {
          content += contentItem.text;
        }
      }
    } else if (typeof rawMessage.message.content === "string") {
      content = rawMessage.message.content;
    }
    
    // If this is just tool results, don't create a separate message
    if (!content && toolResults.length > 0) {
      return null;
    }
    
    return {
      id: messageId,
      type: "user",
      content,
      timestamp,
    };
  }
  
  private formatAssistantMessage(rawMessage: ClaudeMessage, messageId: string, timestamp: string): FormattedMessage | null {
    const msg = rawMessage.message;
    if (!msg?.content || !Array.isArray(msg.content)) return null;
    
    let textContent = "";
    const toolCalls: ToolCall[] = [];
    
    for (const contentItem of msg.content) {
      if (contentItem.type === "text" && contentItem.text) {
        textContent += contentItem.text;
      } else if (contentItem.type === "tool_use") {
        const toolCall: ToolCall = {
          id: contentItem.id,
          name: contentItem.name,
          input: contentItem.input,
        };
        toolCalls.push(toolCall);
        // Store for later result matching
        this.activeToolCalls.set(contentItem.id, toolCall);
      }
    }
    
    // If there's only tool calls and no text, mark as tool use message
    if (toolCalls.length > 0 && !textContent) {
      return {
        id: messageId,
        type: "assistant",
        content: "",
        timestamp,
        isToolUse: true,
        toolCalls,
      };
    }
    
    // If there's text content, create a message with optional tool calls
    if (textContent) {
      return {
        id: messageId,
        type: "assistant",
        content: textContent,
        timestamp,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }
    
    return null;
  }
  
  // Helper method to create a formatted message from raw text (for WebSocket errors, etc.)
  createSystemMessage(content: string): FormattedMessage {
    return {
      id: `sys-${++this.messageCounter}`,
      type: "system",
      content,
      timestamp: new Date().toISOString(),
    };
  }
  
  // Helper method to create connection status messages
  createConnectionMessage(status: "connected" | "connecting" | "error", details?: string): FormattedMessage {
    let content = "";
    switch (status) {
      case "connected":
        content = "Connected to Claude stream...";
        break;
      case "connecting":
        content = details || "Connecting...";
        break;
      case "error":
        content = details || "Connection error";
        break;
    }
    
    return this.createSystemMessage(content);
  }
}