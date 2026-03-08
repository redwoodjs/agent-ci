// --GROK--: Deterministic test double for `claude -p` in agentic mode. Simulates
// what Claude does when `derive tests` spawns it: read spec files from disk,
// generate test files, write them to disk. No AI, no network — just file I/O
// and string templating.
//
// Unlike fake-claude-gen-specs (which returns Gherkin via NDJSON result),
// this binary's primary output is side effects: test files written to disk.
// The NDJSON result is secondary — derive tests doesn't extract it.

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv: string[]): { hasPromptFlag: boolean } {
  let hasPromptFlag = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-p") {
      hasPromptFlag = true;
    } else if (
      ["--verbose", "--include-partial-messages", "--no-session-persistence"].includes(arg)
    ) {
      // no-value flags
    } else if (
      ["--output-format", "--model", "--tools", "--effort", "--system-prompt"].includes(arg)
    ) {
      i++; // skip the value
    }
  }

  return { hasPromptFlag };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

// --GROK--: Extract the spec directory path from the user prompt. The prompt
// format is: "Generate tests for the Gherkin specs at <path>. Read existing..."
// The path may contain dots (e.g. .machinen) so we match up to the ". " boundary
// (period followed by space) rather than stopping at the first dot.
function extractSpecDir(prompt: string): string | null {
  const match = prompt.match(/specs at (.+?)\. /);
  return match?.[1] ?? null;
}

// --GROK--: Generate a deterministic vitest test file from feature content.
// Each Feature: block becomes a describe(), each Scenario: becomes an it().
// The test bodies are placeholder assertions — the point is to produce
// structurally valid test files, not meaningful test logic.
function generateTestContent(featureFile: string, featureContent: string): string {
  const featureMatch = featureContent.match(/^Feature:\s*(.+)/m);
  const featureName = featureMatch?.[1]?.trim() ?? "Unknown";

  const scenarios = [...featureContent.matchAll(/^\s*Scenario:\s*(.+)/gm)].map((m) => m[1].trim());

  const testCases = scenarios
    .map(
      (scenario) =>
        `  it("${scenario.replace(/"/g, '\\"')}", () => {\n` +
        `    expect(true).toBe(true);\n` +
        `  });`,
    )
    .join("\n\n");

  const fallback =
    `  it("placeholder for ${featureName.replace(/"/g, '\\"')}", () => {\n` +
    `    expect(true).toBe(true);\n` +
    `  });`;

  return (
    `import { describe, it, expect } from "vitest";\n\n` +
    `describe("${featureName.replace(/"/g, '\\"')}", () => {\n` +
    `${testCases || fallback}\n` +
    `});\n`
  );
}

// --GROK--: Slugify a feature name into a filename, matching derive's own
// slugify in spec.ts.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.hasPromptFlag) {
    console.error("[fake-claude-gen-tests] -p flag is required");
    process.exit(1);
  }

  const input = await readStdin();

  if (!input.trim()) {
    console.error("[fake-claude-gen-tests] empty stdin");
    process.exit(1);
  }

  const specDir = extractSpecDir(input);
  if (!specDir || !fs.existsSync(specDir)) {
    console.error(`[fake-claude-gen-tests] spec dir not found: ${specDir}`);
    process.exit(1);
  }

  // --GROK--: Read all .feature files from the spec directory — same as what
  // real Claude would do via the Read tool.
  const featureFiles = fs
    .readdirSync(specDir)
    .filter((f) => f.endsWith(".feature"))
    .sort();

  if (featureFiles.length === 0) {
    console.error(`[fake-claude-gen-tests] no .feature files in ${specDir}`);
    process.exit(1);
  }

  // --GROK--: Write one test file per feature file. The output directory is
  // <cwd>/test/generated/ — a predictable location for e2e test assertions.
  const outputDir = path.join(process.cwd(), "test", "generated");
  fs.mkdirSync(outputDir, { recursive: true });

  const writtenFiles: string[] = [];

  for (const file of featureFiles) {
    const content = fs.readFileSync(path.join(specDir, file), "utf8");
    const featureMatch = content.match(/^Feature:\s*(.+)/m);
    const featureName = featureMatch?.[1]?.trim() ?? "unknown";
    const slug = slugify(featureName);
    const testFileName = `${slug}.test.ts`;
    const testFilePath = path.join(outputDir, testFileName);

    const testContent = generateTestContent(file, content);
    fs.writeFileSync(testFilePath, testContent, "utf8");
    writtenFiles.push(testFilePath);

    process.stderr.write(`[fake-claude-gen-tests] wrote ${testFilePath}\n`);
  }

  // --GROK--: Output NDJSON result. derive tests doesn't extract this (it has
  // no onResult callback), but the NDJSON contract requires it for completeness.
  const result = `Generated ${writtenFiles.length} test file(s) from ${featureFiles.length} spec(s).`;
  process.stdout.write(JSON.stringify({ type: "result", result }) + "\n");
}

main().catch((err) => {
  console.error("[fake-claude-gen-tests] fatal:", err);
  process.exit(1);
});
