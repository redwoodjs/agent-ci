import http from "node:http";
import { setCacheDir } from "./server/store.js";
import { bootstrapAndReturnApp } from "./server/index.js";

export interface EphemeralDtu {
  /** Full URL including port, e.g. "http://127.0.0.1:49823" */
  url: string;
  port: number;
  /** Shut down the ephemeral DTU server. */
  close(): Promise<void>;
}

/**
 * Start an ephemeral in-process DTU server on a random OS-assigned port.
 *
 * Each call creates an independent server instance — no shared state between
 * calls. Typical startup overhead is ~50ms.
 *
 * @param cacheDir  Where cache archives should be stored (e.g. `<repo>/.machinen/cache/dtu`).
 */
export async function startEphemeralDtu(cacheDir: string): Promise<EphemeralDtu> {
  // Override the cache directory before bootstrapping so the store writes
  // archives to the repo-scoped path rather than the global tmp dir.
  setCacheDir(cacheDir);

  // Build the Polka app with all routes registered.
  const app = await bootstrapAndReturnApp();

  // Wrap the Polka request handler in a plain Node.js HTTP server so we can
  // bind to port 0 (OS-assigned) and get back the actual port.
  const server = http.createServer((req, res) => {
    // Polka exposes its composed handler as `app.handler`.
    (app as any).handler(req, res);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        return reject(new Error("Unexpected server address type"));
      }
      resolve(addr.port);
    });
    server.on("error", reject);
  });

  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
