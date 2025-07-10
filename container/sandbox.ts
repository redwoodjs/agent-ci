import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";

const PROJECT_PATH: string = process.cwd();

// Define the FileInfo interface
interface FileInfo {
  path: string;
  name: string;
  type: "file" | "directory";
}

// Claude credentials management
interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
  };
}

function createClaudeCredentials(accessToken: string, refreshToken: string, expiresAt: number) {
  const credentials: ClaudeCredentials = {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes: ["org:create_api_key", "user:profile", "user:inference"]
    }
  };

  // Create .claude directory if it doesn't exist
  const claudeDir = path.join(homedir(), '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // Write credentials file
  const credentialsPath = path.join(claudeDir, '.credentials.json');
  fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
  
  console.log(`Claude credentials written to: ${credentialsPath}`);
  return credentialsPath;
}

const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Middleware
app.use("*", logger());
app.use("*", cors({ origin: "*" }));
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'", "ws:", "wss:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  })
);

// Routes

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// File system routes group
const fsRoutes = new Hono();

fsRoutes.get("/list", (c) => {
  // Get query parameters
  const pathname = c.req.query("pathname");
  if (!pathname) {
    return c.json(
      {
        error: "Bad Request",
        message: "pathname is required",
      },
      400
    );
  }

  let absPath = path.join(PROJECT_PATH, pathname);
  if (!fs.statSync(absPath).isDirectory()) {
    // pop off the filename part of the absPath
    absPath = path.dirname(absPath);
  }

  const files = fs.readdirSync(absPath, {
    withFileTypes: true,
  });

  const fileList: FileInfo[] = files.map((file: fs.Dirent): FileInfo => {
    return {
      path: path
        .join(file.parentPath || "", file.name)
        .slice(PROJECT_PATH.length),
      name: file.name,
      type: file.isDirectory() ? "directory" : "file",
    };
  });
  return c.json(fileList);
});

fsRoutes.get("/stat", (c) => {
  const pathname = c.req.query("pathname") as string;
  const stat = fs.statSync(path.join(PROJECT_PATH, pathname));
  return c.json({ type: stat.isDirectory() ? "directory" : "file" });
});

fsRoutes.get("/read", (c) => {
  const pathname = c.req.query("pathname") as string;
  const content = fs.readFileSync(path.join(PROJECT_PATH, pathname), "utf8");
  return c.json({ content });
});

// write
fsRoutes.post("/write", async (c) => {
  const pathname = c.req.query("pathname") as string;
  const body = await c.req.json();
  fs.writeFileSync(path.join(PROJECT_PATH, pathname), body.content);
  return c.json({ message: "File written successfully" });
});

// delete
// fsRoutes.delete("/delete", (c) => {
//   // TODO.
// });

app.route("/fs", fsRoutes);

const ttyRoutes = new Hono();

const shell = pty.spawn("bash", [], {
  name: "xterm-color",
  cols: 80,
  rows: 24,
  encoding: "utf-8",
});

console.log("shell launched:", shell.pid);

ttyRoutes.get(
  "/attach",
  upgradeWebSocket(
    () => {
      console.log("WebSocket upgrade request received");

      return {
        onOpen: (e, ws) => {
          console.log("WebSocket opened");
          shell.onData((data) => {
            ws.send(data);
          });
        },
        onMessage: (e, ws) => {
          console.log("WebSocket message received");
          shell.write(e.data.toString());
        },
        onError: (error) => {
          console.error("WebSocket error:", error);
        },
        onClose: (_e, ws) => {
          console.log("Connection closed");
          ws.close();
        },
      };
    },
    {
      onError: (error) => {
        console.error("WebSocket error:", error);
      },
    }
  )
);

app.route("/tty", ttyRoutes);

// Claude credentials route
app.post("/claude/credentials", async (c) => {
  try {
    const { accessToken, refreshToken, expiresAt } = await c.req.json();
    
    if (!accessToken || !refreshToken || !expiresAt) {
      return c.json({ error: "Missing required fields" }, 400);
    }
    
    const credentialsPath = createClaudeCredentials(accessToken, refreshToken, expiresAt);
    
    return c.json({ 
      success: true, 
      credentialsPath,
      message: "Claude credentials created successfully" 
    });
  } catch (error) {
    console.error("Error creating Claude credentials:", error);
    return c.json({ error: "Failed to create credentials" }, 500);
  }
});

// Error handling
app.notFound((c) => {
  return c.json(
    {
      error: "Not Found",
      message: "The requested resource was not found",
    },
    404
  );
});

app.onError((err, c) => {
  console.error("Server error:", err);
  return c.json(
    {
      error: "Internal Server Error",
      message: "Something went wrong on the server",
    },
    500
  );
});

// Start the server
const port = 8911;
console.log(`🚀 Hono server starting on port ${port}`);

const server = serve({
  fetch: app.fetch,
  port,
});
injectWebSocket(server);
