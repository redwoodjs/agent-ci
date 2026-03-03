import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import type { JsonlMessage } from "./types.js";
import { extractText } from "./reader.js";

const CLAUDE_BIN = path.join(os.homedir(), ".local", "bin", "claude");

const SPEC_ROLE_PREAMBLE = `You are the spec-maintenance agent for a git branch. Your role is to extract testable product behaviours from development conversations and maintain them as a Gherkin specification.

You are writing for a QA engineer who has never seen the source code. They can only interact with the product through its external interfaces — CLI commands, UI, API endpoints, filesystem outputs, or whatever the product exposes. They cannot inspect internals.

Apply the black box test to every scenario: could this scenario be verified by someone who can only use the product's external interfaces, without reading source code or inspecting internal state? If not, do not include it.

Examples of the black box test:
- PASS: "a spec file is created for the branch" — a user can check the filesystem.
- PASS: "running --reset regenerates the spec from scratch" — a user can run the command and observe the result.
- FAIL: "the claude CLI is invoked with --print" — a user cannot observe how subprocess calls are made.
- FAIL: "conversation offsets are stored in SQLite" — a user cannot inspect internal database state.
- FAIL: "the CLAUDECODE env var is stripped before spawning" — a user cannot observe environment variable handling.

Rules:
1. Extract the intent, behaviour, and requirements described or implied in the conversations.
2. Output ONLY Gherkin — Feature blocks with Scenario entries using Given/When/Then/And steps.
3. Do NOT output Markdown headings, tables, code fences, architecture descriptions, invariants, or commentary.
4. Do NOT wrap the Gherkin in code blocks or backticks — output it as plain text.
5. Group related behaviours under Feature blocks. Use descriptive Scenario names.
6. When updating an existing spec, preserve scenarios that are still valid, revise those that have changed, and add new ones as needed.
7. Ignore conversations about debugging, investigation, internal refactoring, or tooling workarounds — these are not product behaviours.`;

async function runClaude(systemPrompt: string, prompt: string): Promise<string> {
  console.log(
    `[claude] running | system: ${systemPrompt.length} chars | prompt: ${prompt.length} chars`,
  );

  const env = { ...process.env };
  delete env.CLAUDECODE;

  // --system-prompt replaces the default system prompt entirely, stripping any
  // inherited style instructions (e.g. explanatory output mode) that would
  // otherwise cause the agent to emit commentary alongside the Gherkin.
  //
  // Prompt is piped via stdin (execa's `input` option) rather than passed as a
  // CLI arg to avoid E2BIG when the prompt exceeds the OS arg length limit.
  //
  // --GROK--: We pipe stderr to the parent process in real time so we can see
  // progress during long-running claude calls. stdout is still collected into
  // a buffer since we need the full result as a return value.
  const proc = execa(CLAUDE_BIN, ["-p", "--system-prompt", systemPrompt], {
    env,
    input: prompt,
    extendEnv: false,
    stderr: "pipe",
  });

  proc.stderr?.pipe(process.stderr);

  const result = await proc;

  console.log(`[claude] result: ${result.stdout.trim().length} chars`);
  return result.stdout;
}

const REVIEW_SYSTEM_PROMPT = `You are a spec reviewer. Your job is to review a Gherkin specification and produce a clean, non-redundant version that contains only externally observable product behaviours.

You perform four operations, in order:

1. FILTER — Apply the black box test to each scenario: could a QA engineer verify this scenario using only the product's external interfaces (CLI, UI, API, filesystem outputs) without reading source code or inspecting internal state?
   - REMOVE scenarios about: internal function calls, database schemas, environment variables, subprocess flags, internal error handling, logging, internal data formats, or how something is implemented.
   - KEEP scenarios about: what a user can do, what they observe, what outputs the system produces, how it responds to user actions.

2. DEDUPLICATE — Identify scenarios that describe the same observable behaviour under different names or wording. Merge them into one, keeping the more specific or descriptive version. If two scenarios say the same thing differently, keep one and discard the other.

3. CONSOLIDATE — When the same invariant or rule appears in multiple Features (e.g., "other branches are ignored" stated separately for one-shot mode and watch mode), keep it in the most natural location and remove the duplicate. If it applies universally, state it once.

4. SIMPLIFY — Remove scenarios whose assertion is already fully encoded in another scenario. For example, if one scenario states "the spec file is written to .machinen/specs/feature-x.gherkin", a separate scenario stating "the spec file uses the .gherkin extension" adds nothing and should be removed.

Rules:
- Do NOT invent new scenarios or add behaviours not present in the input.
- When merging two scenarios, the result must be traceable to the originals — do not introduce new assertions.
- Preserve Feature groupings unless restructuring is necessary to eliminate a cross-feature duplicate. Prefer removing a duplicate over reorganising.
- Output ONLY the reviewed Gherkin — no commentary, no explanations, no markdown.`;

async function reviewSpec(gherkin: string): Promise<string> {
  console.log(`[review] reviewing spec | ${gherkin.trim().length} chars`);
  const prompt = `Here is the Gherkin specification to review:\n\n${gherkin}\n\nFilter, deduplicate, consolidate, and simplify. Output only the reviewed Gherkin.`;
  return runClaude(REVIEW_SYSTEM_PROMPT, prompt);
}

const MAX_EXCERPT_CHARS = 300_000;

// Reads the current spec from disk (if any), combines it with new conversation
// excerpts, and asks Claude to produce an updated spec. If excerpts exceed
// MAX_EXCERPT_CHARS, they are split into chunks and processed sequentially —
// each chunk reads the spec back from disk (as updated by the previous chunk).
export async function updateSpec(messages: JsonlMessage[], sPath: string): Promise<void> {
  const excerptLines = messages
    .map((m) => `[${m.type}]: ${extractText(m)}`)
    .filter((s) => s.trim());

  if (excerptLines.length === 0) {
    return;
  }

  // Split excerpt lines into size-bounded chunks
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentSize = 0;

  for (const line of excerptLines) {
    if (currentSize + line.length > MAX_EXCERPT_CHARS && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(line);
    currentSize += line.length;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  for (const [i, chunk] of chunks.entries()) {
    const excerpts = chunk.join("\n\n---\n\n");

    if (chunks.length > 1) {
      console.log(
        `[spec] chunk ${i + 1}/${chunks.length} | ${chunk.length} messages | ${excerpts.length} chars`,
      );
    } else {
      console.log(`[spec] sending ${chunk.length} messages | ${excerpts.length} chars of excerpts`);
    }

    const currentSpec = fs.existsSync(sPath) ? fs.readFileSync(sPath, "utf8") : null;

    let prompt: string;
    if (currentSpec) {
      prompt = `Here is the current spec:\n\n${currentSpec}\n\n---\n\nNew conversation excerpts from the feature branch:\n\n${excerpts}\n\nPlease update the spec accordingly. Output only the updated Gherkin.`;
    } else {
      prompt = `This is a new branch with no existing spec. Here are the first conversation excerpts:\n\n${excerpts}\n\nPlease create the initial spec. Output only Gherkin.`;
    }

    const result = await runClaude(SPEC_ROLE_PREAMBLE, prompt);

    if (!result.trim()) {
      throw new Error("claude CLI returned empty result for spec update");
    }

    const reviewed = await reviewSpec(result);

    if (!reviewed.trim()) {
      throw new Error("review pass returned empty result");
    }

    fs.mkdirSync(path.dirname(sPath), { recursive: true });
    fs.writeFileSync(sPath, reviewed, "utf8");
  }
}

// --GROK--: Spec files live in the project directory so they travel with the
// branch via git. The extension is .gherkin to reflect the actual content format.
export function specFilePath(repoPath: string, branch: string): string {
  return path.join(repoPath, ".machinen", "specs", `${branch}.gherkin`);
}
