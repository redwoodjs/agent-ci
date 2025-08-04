import { defineConfig } from "vite";
import { redwood } from "rwsdk/vite";

export default defineConfig({
  plugins: [redwood()],
  server: {
    port: 8910,
    allowedHosts: true,
  },
});
