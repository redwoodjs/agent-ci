"use strict";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { createOpencodeServer } from "@opencode-ai/sdk";
const opencode = await createOpencodeServer({
  hostname: "127.0.0.1",
  port: 4096,
  config: {}
});
console.log("Opencode server started on port 4096");
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
const PROJECT_PATH = process.cwd();
function createClaudeCredentials(accessToken, refreshToken, expiresAt) {
  const credentials = {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      scopes: ["org:create_api_key", "user:profile", "user:inference"]
    }
  };
  const claudeDir = path.join(homedir(), ".claude");
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  const credentialsPath = path.join(claudeDir, ".credentials.json");
  fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
  console.log(`Claude credentials written to: ${credentialsPath}`);
  return credentialsPath;
}
const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
app.use("*", logger());
app.use("*", cors({ origin: "*" }));
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'", "ws:", "wss:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  })
);
app.get("/", (c) => {
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
});
function isProcessRunning(pid) {
  try {
    console.log("process running", pid);
    process.kill(parseInt(pid), 0);
    return true;
  } catch (error) {
    console.log("process not running", pid);
    return false;
  }
}
app.get("/process/:pid/:processId", (c) => {
  const pid = c.req.param("pid");
  const processId = c.req.param("processId");
  if (!pid || !processId) {
    return c.json(
      { error: "Bad Request", message: "processId is required" },
      400
    );
  }
  const stdout = `/tmp/proc_${processId}.stdout`;
  const stderr = `/tmp/proc_${processId}.stderr`;
  if (!fs.existsSync(stdout) || !fs.existsSync(stderr)) {
    return c.json(
      { error: "Not Found", message: "Process log files not found" },
      404
    );
  }
  const stream = new ReadableStream({
    start(controller) {
      let lastSize = 0;
      const initialStream = fs.createReadStream(stdout);
      initialStream.on("data", (chunk) => {
        controller.enqueue(chunk);
        lastSize += chunk.length;
      });
      initialStream.on("end", () => {
        console.log("initialStream end", pid);
        if (isProcessRunning(pid)) {
          fs.watchFile(stdout, (curr) => {
            if (curr.size > lastSize) {
              const newStream = fs.createReadStream(stdout, {
                start: lastSize
              });
              newStream.on("data", (chunk) => {
                controller.enqueue(chunk);
              });
              lastSize = curr.size;
              if (!isProcessRunning(pid)) {
                fs.unwatchFile(stdout);
                controller.close();
              }
            }
          });
        } else {
          controller.close();
        }
      });
      initialStream.on("error", (err) => {
        fs.unwatchFile(stdout);
        controller.error(err);
      });
    }
  });
  return new Response(stream);
});
const ttyRoutes = new Hono();
const shell = pty.spawn("bash", [], {
  name: "xterm-color",
  cols: 80,
  rows: 24,
  encoding: "utf-8"
});
console.log("shell launched:", shell.pid);
ttyRoutes.get(
  "/:containerId/attach",
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
        }
      };
    },
    {
      onError: (error) => {
        console.error("WebSocket error:", error);
      }
    }
  )
);
const activeProcesses = /* @__PURE__ */ new Map();
const processOutputs = /* @__PURE__ */ new Map();
const processStatuses = /* @__PURE__ */ new Map();
ttyRoutes.post("/exec", async (c) => {
  try {
    const { command } = await c.req.json();
    if (!command) {
      return c.json({ error: "Command is required" }, 400);
    }
    const processId = `process_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const claudeShell = pty.spawn("bash", ["-c", command], {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      encoding: "utf-8",
      cwd: PROJECT_PATH
    });
    activeProcesses.set(processId, claudeShell);
    processOutputs.set(processId, "");
    processStatuses.set(processId, false);
    claudeShell.onData((data) => {
      try {
        const currentOutput = processOutputs.get(processId) || "";
        processOutputs.set(processId, currentOutput + data);
      } catch (error) {
      }
    });
    claudeShell.onExit(() => {
      try {
        processStatuses.set(processId, true);
        setTimeout(() => {
          try {
            activeProcesses.delete(processId);
            processOutputs.delete(processId);
            processStatuses.delete(processId);
          } catch (error) {
          }
        }, 3e4);
      } catch (error) {
      }
    });
    return c.json({
      processId,
      message: "Command execution started"
    });
  } catch (error) {
    console.error("Error executing command:", error);
    return c.json({ error: "Failed to execute command" }, 500);
  }
});
ttyRoutes.get(
  "/output",
  upgradeWebSocket((c) => {
    const processId = c.req.query("processId");
    return {
      onOpen: async (e, ws) => {
        console.log(`WebSocket opened for process ${processId}`);
        if (!processId) {
          console.log(`No processId provided`);
          ws.send(JSON.stringify({ error: "Process ID is required" }));
          ws.close();
          return;
        }
        const waitForProcess = async (retries = 20, delay = 100) => {
          for (let i = 0; i < retries; i++) {
            if (activeProcesses.has(processId)) {
              return activeProcesses.get(processId);
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
          return null;
        };
        const process2 = await waitForProcess();
        if (!process2) {
          ws.send(JSON.stringify({ error: "Process not found or timed out" }));
          ws.close();
          return;
        }
        const existingOutput = processOutputs.get(processId) || "";
        if (existingOutput) {
          ws.send(existingOutput);
        }
        const dataHandler = (data) => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(data);
            }
          } catch (error) {
          }
        };
        const exitHandler = (exitCode) => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "exit",
                  exitCode,
                  message: `Process exited with code ${exitCode?.exitCode || 0}`
                })
              );
            }
          } catch (error) {
          }
          try {
            process2.off("data", dataHandler);
            process2.off("exit", exitHandler);
          } catch (error) {
          }
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          } catch (error) {
          }
        };
        try {
          process2.onData(dataHandler);
          process2.onExit(exitHandler);
        } catch (error) {
          ws.send(
            JSON.stringify({ error: "Failed to set up process listeners" })
          );
          ws.close();
          return;
        }
        if (processStatuses.get(processId) === true) {
          ws.send(
            JSON.stringify({
              type: "exit",
              exitCode: 0,
              message: "Process already completed"
            })
          );
          ws.close();
        }
      },
      onMessage: (e, ws) => {
        if (processId && activeProcesses.has(processId)) {
          const process2 = activeProcesses.get(processId);
          process2.write(e.data.toString());
        }
      },
      onError: () => {
      },
      onClose: () => {
      }
    };
  })
);
app.route("/term", ttyRoutes);
app.post("/claude/credentials", async (c) => {
  try {
    const { accessToken, refreshToken, expiresAt } = await c.req.json();
    if (!accessToken || !refreshToken || !expiresAt) {
      return c.json({ error: "Missing required fields" }, 400);
    }
    const credentialsPath = createClaudeCredentials(
      accessToken,
      refreshToken,
      expiresAt
    );
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
app.notFound((c) => {
  return c.json(
    {
      error: "Not Found",
      message: "The requested resource was not found"
    },
    404
  );
});
app.onError((err, c) => {
  console.error("Server error:", err);
  return c.json(
    {
      error: "Internal Server Error",
      message: "Something went wrong on the server"
    },
    500
  );
});
const port = 8910;
console.log(`\u{1F680} Hono server starting on port ${port}`);
const server = serve({
  fetch: app.fetch,
  port
});
injectWebSocket(server);
