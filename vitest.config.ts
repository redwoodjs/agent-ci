import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["_/**", ".machinen/**", "**/node_modules/**", "**/dist/**"],
  },
});
