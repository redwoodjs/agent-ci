#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// --- Configuration ---
const API_KEY = process.env.MACHINEN_API_KEY;
const API_URL =
  process.env.MACHINEN_API_URL || "https://machinen.redwoodjs.workers.dev";

if (!API_KEY) {
  console.error(
    "Error: MACHINEN_API_KEY environment variable is required."
  );
  process.exit(1);
}

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
  return {
    tools: [
      {
        name: "search_machinen",
        description:
          "Search the internal Machinen knowledge base. Use this ONLY when the user asks about specific project history, architectural decisions, previous bugs, or internal discussions from GitHub/Discord. Do NOT use for general coding questions or generic syntax help.",
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
});

// --- Tool Execution ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "search_machinen") {
    const { query } = request.params.arguments as { query: string };

    try {
      const response = await fetch(`${API_URL}/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
        },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) {
        const errorText = await response.text();
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

      return {
        content: [
          {
            type: "text",
            text: data.response,
          },
        ],
      };
    } catch (error) {
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

  throw new Error(`Tool not found: ${request.params.name}`);
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Machinen MCP Server running on stdio");
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

