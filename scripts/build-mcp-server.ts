import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..");

await build({
  entryPoints: [
    join(repoRoot, "src/app/ingestors/cursor/scripts/mcp-server.ts"),
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(repoRoot, "dist/cursor/mcp-server.mjs"),
  external: [],
  minify: false,
  sourcemap: false,
  target: "node20",
});

console.log("✓ Built MCP server to dist/cursor/mcp-server.mjs");

