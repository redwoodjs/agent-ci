import { defineConfig } from "vite";
import { redwood } from "rwsdk/vite";

export default defineConfig({
  plugins: [redwood()],
  server: {
    port: 8910,
    allowedHosts: true,
    proxy: {
      "/sandbox": {
        target: "http://localhost:8911/",
        rewrite: (path) => path.replace(/^\/sandbox/, ""),
        changeOrigin: true,
      },
    },
  },
});

// TODO: Convert sandbox into a vite plugin.
