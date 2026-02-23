import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["_/**", "dist/**", "node_modules/**"],
  },
});
