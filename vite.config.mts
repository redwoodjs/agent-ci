import { defineConfig, Plugin, ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  environments: {
    ssr: {},
  },
  plugins: [
    proxyWebSocketPlugin(),
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
    redwood(),
    tailwindcss(),
  ],
});

function proxyWebSocketPlugin(): Plugin {
  return {
    name: "proxyWebSocketPlugin",
    enforce: "pre",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/preview/")) {
          const url = new URL(req.url, "http://localhost");
          if (url.search) {
            const originalQuery = url.search.slice(1); // Remove '?'
            url.search = ""; // Remove all query params
            url.searchParams.set(
              "__x_internal_query",
              encodeURIComponent(originalQuery)
            );
            req.url = url.pathname + url.search;
          }
        }
        next();
      });

      if (server.httpServer) {
        server.httpServer.on("upgrade", (req, socket, head) => {
          if (req.url?.startsWith("/preview/")) {
            const protocolHeaderKey = Object.keys(req.headers).find(
              (k) => k.toLowerCase() === "sec-websocket-protocol"
            );
            if (protocolHeaderKey) {
              req.headers["x-websocket-protocol"] =
                req.headers[protocolHeaderKey];
              delete req.headers[protocolHeaderKey];
            }
            return;
          }
        });
      }
    },
  };
}
