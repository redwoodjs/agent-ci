import { defineConfig, Plugin, ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { spawn, spawnSync, ChildProcess } from "node:child_process";

export default defineConfig({
  environments: {
    ssr: {},
  },
  plugins: [
    externalProcessPlugin(),
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
    redwood(),
    tailwindcss(),
  ],
});

function externalProcessPlugin(): Plugin {
  let childProcess: ChildProcess | null = null;

  return {
    name: "external-process",
    enforce: "pre",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/__machinen/", (req, res, next) => {
        if (req.url?.startsWith("/process/start")) {
          const result = spawnSync(
            `docker run -P -l rwsdk-session -d rwsdk:latest`,
            {
              stdio: "pipe",
              shell: true,
              encoding: "utf8",
            }
          );

          if (result.error) {
            console.error("[machinen] docker run error:", result.error);
            return res.end(
              JSON.stringify({
                success: false,
                error: result.error.message,
              })
            );
          }

          if (result.stderr) {
            console.error("[machinen] docker run stderr:", result.stderr);
          }

          console.log("[machinen] docker run output:", result.stdout);
          console.log("[machinen] docker run exit code:", result.status);

          res.setHeader("Content-Type", "application/json");
          return res.end(
            JSON.stringify({
              success: true,
              data: {
                pid: result.pid,
              },
              stdout: result.stdout,
              stderr: result.stderr,
            })
          );
        }

        if (req.url?.startsWith("/process/list")) {
          const result = spawnSync(
            `docker ps --filter "label=rwsdk-session" --format=json`,
            {
              stdio: "pipe",
              shell: true,
              encoding: "utf8",
            }
          );

          if (result.error) {
            console.error("[machinen] docker ps error:", result.error);
            return res.end(
              JSON.stringify({
                success: false,
                error: result.error.message,
              })
            );
          }

          if (result.stderr) {
            console.error("[machinen] docker ps stderr:", result.stderr);
          }

          console.log("[machinen] docker ps output:", result.stdout);
          console.log("[machinen] docker ps exit code:", result.status);

          let data = [];

          try {
            // Docker outputs one JSON object per line, so we need to split and parse each line
            const lines = result.stdout
              .trim()
              .split("\n")
              .filter((line) => line.trim());
            data = lines.map((line) => JSON.parse(line));
          } catch (error) {
            console.error("[machinen] docker ps JSON parse error:", error);
            data = [];
          }

          res.setHeader("Content-Type", "application/json");
          return res.end(
            JSON.stringify({
              success: true,
              data: data,
              stdout: result.stdout,
              stderr: result.stderr,
            })
          );
        }

        next();
      });
    },
    buildEnd() {
      if (childProcess) {
        childProcess.kill();
        childProcess = null;
      }
    },
  };
}
