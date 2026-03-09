// Deterministic test double for `claude -p` that produces valid Gherkin
// from stdin input. Used via CLAUDE_BIN env var override in e2e tests. No AI,
// no network, no model — just keyword extraction and string templating.
//
// derive calls `claude -p` twice per spec update (extraction + review). Both
// calls pipe stdin and expect NDJSON with a {"type":"result","result":"..."} line.
// This stub satisfies that contract with deterministic output derived from the
// input keywords.

import keyword_extractor from "keyword-extractor";

// Parse the subset of CLI flags that derive passes to `claude -p`.
// We only need -p as a mode gate. Everything else is accepted silently so
// derive doesn't get arg errors when spawning us.
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

// Extract flag tokens (--reset, --scope, etc.) from text. These are
// always meaningful in derive conversations — they represent CLI features being
// discussed.
function extractFlags(text: string): string[] {
  const matches = text.match(/--[a-z][-a-z]*/g);
  if (!matches) {
    return [];
  }
  return [...new Set(matches)];
}

// Extract conversation lines — the [human]: and [assistant]: prefixed
// lines that derive's excerpt format uses. These contain the actual feature
// discussion content. We strip the prefix to get clean text for keyword extraction.
function extractConversationText(input: string): string {
  const lines = input.split("\n");
  const conversationLines = lines
    .filter((line) => /^\[(?:human|assistant)\]:/.test(line.trim()))
    .map((line) => line.replace(/^\[(?:human|assistant)\]:\s*/, "").trim());

  // If no conversation-formatted lines found, fall back to using all
  // non-empty lines. This handles cases where the input is a plain prompt (e.g.
  // the review pass, which sends raw Gherkin without conversation prefixes).
  if (conversationLines.length === 0) {
    return lines.filter((l) => l.trim()).join(" ");
  }

  return conversationLines.join(" ");
}

// uild Gherkin output from extracted keywords. Each flag becomes its
// own scenario (flags are the most concrete, testable tokens). Remaining keywords
// are grouped into a single "general behavior" scenario to avoid producing dozens
// of trivial one-keyword scenarios.
function buildGherkin(flags: string[], keywords: string[]): string {
  const scenarios: string[] = [];

  for (const flag of flags) {
    const name = flag.replace(/^--/, "");
    scenarios.push(
      `  Scenario: ${name} flag behavior\n` +
        `    Given the system is initialized\n` +
        `    When the user invokes ${flag}\n` +
        `    Then the expected behavior for ${name} is observed`,
    );
  }

  if (keywords.length > 0) {
    const keywordPhrase = keywords.slice(0, 5).join(", ");
    scenarios.push(
      `  Scenario: ${keywords[0]} behavior\n` +
        `    Given the system is initialized\n` +
        `    When the user triggers ${keywordPhrase}\n` +
        `    Then the expected behavior is observed`,
    );
  }

  // Fallback — if we extracted nothing at all, produce a minimal valid
  // Feature block. writeSpec needs at least one Feature: to produce a .feature file.
  if (scenarios.length === 0) {
    scenarios.push(
      `  Scenario: default behavior\n` +
        `    Given the system is initialized\n` +
        `    When the user performs an action\n` +
        `    Then the expected behavior is observed`,
    );
  }

  return `Feature: Extracted specification\n\n${scenarios.join("\n\n")}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.hasPromptFlag) {
    console.error("[fake-claude-gen-specs] -p flag is required");
    process.exit(1);
  }

  const input = await readStdin();

  if (!input.trim()) {
    console.error("[fake-claude-gen-specs] empty stdin");
    process.exit(1);
  }

  const conversationText = extractConversationText(input);
  const flags = extractFlags(conversationText);

  // --GROK--: keyword-extractor strips English stopwords and returns meaningful
  // words. return_chained_words preserves multi-word phrases when adjacent
  // non-stopwords appear together. remove_duplicates keeps the output clean.
  const keywords = keyword_extractor.extract(conversationText, {
    language: "english",
    remove_digits: true,
    return_changed_case: true,
    remove_duplicates: true,
    return_chained_words: true,
  });

  const gherkin = buildGherkin(flags, keywords);

  // --GROK--: derive's runClaude parser only cares about {"type":"result","result":"..."}.
  const output = JSON.stringify({ type: "result", result: gherkin });
  process.stdout.write(output + "\n");
}

main().catch((err) => {
  console.error("[fake-claude-gen-specs] fatal:", err);
  process.exit(1);
});
