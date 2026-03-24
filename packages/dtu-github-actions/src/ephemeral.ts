import http from "node:http";
import { setCacheDir } from "./server/store.js";
import { bootstrapAndReturnApp } from "./server/index.js";

export interface EphemeralDtu {
  /** Full URL including port for CLI access (127.0.0.1), e.g. "http://127.0.0.1:49823" */
  url: string;
  /** Full URL including port for container access (host IP), e.g. "http://172.17.0.1:49823" */
  containerUrl: string;
  port: number;
  /** Shut down the ephemeral DTU server. */
  close(): Promise<void>;
}

function resolveContainerHost(): string {
  const configuredHost = process.env.AGENT_CI_DTU_HOST?.trim();
  return configuredHost || "host.docker.internal";
}

/**
 * Start an ephemeral in-process DTU server on a random OS-assigned port.
 *
 * Each call creates an independent server instance — no shared state between
 * calls. Typical startup overhead is ~50ms.
 *
 * @param cacheDir  Where cache archives should be stored (e.g. `os.tmpdir()/agent-ci/<repo>/cache/dtu`).
 */
export async function startEphemeralDtu(cacheDir: string): Promise<EphemeralDtu> {
  // Override the cache directory before bootstrapping so the store writes
  // archives to the repo-scoped path rather than the global tmp dir.
  setCacheDir(cacheDir);

  // Build the Polka app with all routes registered.
  const app = await bootstrapAndReturnApp({ reset: false });

  // Wrap the Polka request handler in a plain Node.js HTTP server so we can
  // bind to port 0 (OS-assigned) and get back the actual port.
  const server = http.createServer((req, res) => {
    // Polka exposes its composed handler as `app.handler`.
    (app as any).handler(req, res);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        return reject(new Error("Unexpected server address type"));
      }
      resolve(addr.port);
    });
    server.on("error", reject);
  });

  // Use 127.0.0.1 for CLI access (same host) and host IP for container access
  const containerHost = resolveContainerHost();
  const cliUrl = `http://127.0.0.1:${port}`;
  const containerUrl = `http://${containerHost}:${port}`;

  return {
    url: cliUrl,
    containerUrl,
    port,
    close(): Promise<void> {
      return new Promise((resolve) => {
        // Force-close all existing connections (HTTP keep-alive etc.)
        // so the server shuts down immediately instead of waiting for
        // idle connections to drain.
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
