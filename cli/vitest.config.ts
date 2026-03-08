import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    isolate: true,
    exclude: ["_/**", "dist/**", "node_modules/**"],
    testTimeout: 30_000,
    server: {
      deps: {
        // @actions/workflow-parser imports a JSON file without `with { type: "json" }`,
        // which Node 22+ rejects in native ESM. Inlining forces Vite to bundle it,
        // and Vite handles JSON imports transparently.
        inline: ["@actions/workflow-parser"],
      },
    },
  },
});
