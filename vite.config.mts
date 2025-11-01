import { defineConfig, Plugin, ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";

const opencodeSdkClientPath = fileURLToPath(
  import.meta.resolve("@opencode-ai/sdk/client")
);

export default defineConfig({
  environments: {
    ssr: {},
  },
  resolve: {
    alias: {
      "@opencode-ai/sdk/client": opencodeSdkClientPath,
    },
  },

  plugins: [
    cloudflare({
      viteEnvironment: { name: "worker" },
    }),
    redwood(),
    tailwindcss(),
  ],
  logLevel: "info",
});
