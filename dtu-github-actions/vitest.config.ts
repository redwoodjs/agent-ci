import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run test files sequentially to prevent src/ and dist/ tests from
    // racing on the shared _/logs/404.log file path.
    maxConcurrency: 1,
    fileParallelism: false,
    exclude: ["dist/**", "node_modules/**"],
  },
});
