import { defineConfig, Plugin, ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import cloudflareTunnel from "vite-plugin-cloudflare-tunnel";

export default defineConfig({
  environments: {
    ssr: {},
    worker: {
      resolve: {
        conditions: ["import"],
      },
    },
  },

  server: {
    allowedHosts: ["p4p8.machinen.dev"],
  },

  plugins: [
    // proxyWebSocketPlugin(),
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
    redwood(),
    tailwindcss(),
    // cloudflareTunnel(),
  ],
  logLevel: "info",
});
