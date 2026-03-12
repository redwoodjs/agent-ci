import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["_/**", ".agent-ci/**", "**/node_modules/**", "**/dist/**"],
  },
});
