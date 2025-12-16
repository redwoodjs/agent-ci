import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { writeFileSync, appendFileSync } from "fs";

const LOG_FILE = "/tmp/machinen-mcp-server.log";

function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}${
    data ? `\n${JSON.stringify(data, null, 2)}` : ""
  }\n`;
  try {
    appendFileSync(LOG_FILE, logEntry);
  } catch (err) {
    console.error(`[LOG ERROR] Failed to write to ${LOG_FILE}:`, err);
    console.error(`[LOG] ${logEntry}`);
  }
}

try {
  writeFileSync(LOG_FILE, `=== Machinen MCP Server Started ===\n`);
  log("Server initializing");
} catch (err) {
  console.error(`[LOG ERROR] Failed to create log file ${LOG_FILE}:`, err);
  console.error("[LOG] Server initializing (log file unavailable)");
}

// --- Configuration ---
const API_KEY = process.env.MACHINEN_API_KEY;
const API_URL =
  process.env.MACHINEN_API_URL || "https://machinen.redwoodjs.workers.dev";
const RESPONSE_MODE = process.env.MACHINEN_RESPONSE_MODE || "brief";

if (!API_KEY) {
  const error = "Error: MACHINEN_API_KEY environment variable is required.";
  log("ERROR: Missing API key");
  console.error(error);
  process.exit(1);
}

log("Configuration loaded", { API_URL, hasApiKey: !!API_KEY });

// --- Server Setup ---
const server = new Server(
  {
    name: "machinen-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// --- Tool Definitions ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  log("ListTools request received");
  const tools = {
    tools: [
      {
        name: "search_machinen",
        description:
          "Search Machinen's knowledge base for project context, architecture docs, implementation details, or any project-related information. Call this FIRST when you need to understand how something works, find documentation, learn about the codebase structure, or get context before making changes. Examples: 'How does X work?', 'Where is Y implemented?', 'What is the architecture of Z?', 'How do I do X in this project?'. Always use this before guessing or making assumptions about the codebase.",
        inputSchema: zodToJsonSchema(
          z.object({
            query: z
              .string()
              .describe("The search query to find relevant context"),
          })
        ),
      },
    ],
  };
  log("Returning tools list", tools);
  return tools;
});

// --- Tool Execution ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  log("CallTool request received", {
    toolName: request.params.name,
    arguments: request.params.arguments,
  });

  if (request.params.name === "search_machinen") {
    const { query } = request.params.arguments as { query: string };
    log("Executing search_machinen", { query });

    try {
      log("Making API request", { url: `${API_URL}/query`, query });
      const response = await fetch(`${API_URL}/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ query, responseMode: RESPONSE_MODE }),
      });

      log("API response received", {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
      });

      if (!response.ok) {
        const errorText = await response.text();
        log("API error response", { status: response.status, errorText });
        return {
          content: [
            {
              type: "text",
              text: `Error querying Machinen API: ${response.status} ${response.statusText}\n${errorText}`,
            },
          ],
          isError: true,
        };
      }

      const text = await response.text();
      log("API success response", {
        responseMode: RESPONSE_MODE,
        responseLength: text?.length || 0,
        responsePreview: text?.substring(0, 200),
      });

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };
    } catch (error) {
      log("Exception during tool execution", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        content: [
          {
            type: "text",
            text: `Internal Error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  const error = `Tool not found: ${request.params.name}`;
  log("ERROR: Unknown tool", { toolName: request.params.name });
  throw new Error(error);
});

// --- Helpers ---
// Simple Zod to JSON Schema converter to avoid extra dependencies if possible,
// but for now we use a simplified structural representation compatible with the SDK.
function zodToJsonSchema(schema: z.ZodType<any>): any {
  // This is a simplified converter for the specific schema we use.
  // In a real app, you might use `zod-to-json-schema` package.
  return {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query to find relevant context",
      },
    },
    required: ["query"],
  };
}

// --- Error Handler for Unhandled Requests ---
server.onerror = (error) => {
  log("Server error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  console.error("MCP Server error:", error);
};

// --- Start Server ---
async function run() {
  try {
    log("Starting server transport");
    const transport = new StdioServerTransport();
    log("Connecting server to transport");
    await server.connect(transport);
    log("Server connected and running on stdio");
    console.error("Machinen MCP Server running on stdio");
    console.error(`Debug logs: ${LOG_FILE}`);
  } catch (error) {
    log("ERROR in run()", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

run().catch((error) => {
  try {
    log("FATAL ERROR", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } catch {
    // If logging fails, at least log to stderr
  }
  console.error("Fatal error running server:", error);
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
