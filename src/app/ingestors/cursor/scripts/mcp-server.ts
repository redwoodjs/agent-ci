#!/usr/bin/env node
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
  appendFileSync(LOG_FILE, logEntry);
}

writeFileSync(LOG_FILE, `=== Machinen MCP Server Started ===\n`);
log("Server initializing");

// --- Configuration ---
const API_KEY = process.env.MACHINEN_API_KEY;
const API_URL =
  process.env.MACHINEN_API_URL || "https://machinen.redwoodjs.workers.dev";

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
          "Search the internal Machinen knowledge base for any information. Use this tool whenever you need to find context, documentation, or information about the project. Or if the user is debugging machinen itself, use it at all times.",
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
      log("Making API request", { url: `${API_URL}/rag/query`, query });
      const response = await fetch(`${API_URL}/rag/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ query }),
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

      const data = (await response.json()) as { response: string };
      log("API success response", {
        responseLength: data.response?.length || 0,
        responsePreview: data.response?.substring(0, 200),
      });

      return {
        content: [
          {
            type: "text",
            text: data.response,
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

// --- Start Server ---
async function run() {
  log("Starting server transport");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Server connected and running on stdio");
  console.error("Machinen MCP Server running on stdio");
  console.error(`Debug logs: ${LOG_FILE}`);
}

run().catch((error) => {
  log("FATAL ERROR", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  console.error("Fatal error running server:", error);
  process.exit(1);
});
