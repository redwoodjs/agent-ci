import { defineConfig, Plugin, ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import cloudflareTunnel from "vite-plugin-cloudflare-tunnel";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const opencodeSdkClientPath = fileURLToPath(
  import.meta.resolve("@opencode-ai/sdk/client")
);

export default defineConfig({
  environments: {
    ssr: {},
  },

  server: {
    allowedHosts: ["p4p8.machinen.dev"],
  },

  resolve: {
    alias: {
      "@opencode-ai/sdk/client": opencodeSdkClientPath,
    },
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
