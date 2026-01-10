import { defineConfig, Plugin, ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { redwood } from "rwsdk/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { fileURLToPath } from "node:url";

export default defineConfig({
  environments: {
    ssr: {},
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
