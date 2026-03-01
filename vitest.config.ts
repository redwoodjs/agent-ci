import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["_/**", "**/node_modules/**", "**/dist/**"],
  },
});
