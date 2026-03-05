import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import type { JsonlMessage } from "./types.js";
import { extractText } from "./reader.js";

export const CLAUDE_BIN =
  process.env.CLAUDE_BIN ?? path.join(os.homedir(), ".local", "bin", "claude");

// --GROK--: When --verbose is passed to derive itself, we dump raw NDJSON
// events from the spawned claude process so we can inspect the full stream.
const VERBOSE = process.argv.includes("--verbose");

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

// --GROK--: --system-prompt is a short, fixed override that replaces the
// default system prompt (stripping inherited style instructions like
// explanatory output mode). The detailed role instructions (preamble) are
// prepended to the stdin input alongside the prompt, keeping the CLI arg
// short and avoiding E2BIG.
const SYSTEM_PROMPT_OVERRIDE = "Output only Gherkin. No commentary, no markdown, no code fences.";

// --GROK--: Shared NDJSON streaming logic. Parses claude -p stream-json output,
// logs progress to stderr (thinking, tool_use, text generation), and calls
// onResult when the final result event arrives. Used by both runClaude (spec
// pipeline) and runGenTests (test generation).
export interface StreamNdjsonCallbacks {
  onResult?: (result: string) => void;
}

export function streamNdjsonProgress(
  stdout: NodeJS.ReadableStream,
  callbacks: StreamNdjsonCallbacks = {},
): { getTextChunks: () => number } {
  let textChunks = 0;
  let buf = "";
  let currentBlockType: string | null = null;
  let currentToolName: string | null = null;
  let toolInputBuf = "";

  stdout.on("data", (data: Buffer) => {
    buf += data.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const obj = JSON.parse(line);
        if (VERBOSE) {
          console.log(`[claude:raw] ${line.slice(0, 500)}${line.length > 500 ? "..." : ""}`);
        }
        if (obj.type === "stream_event") {
          const evt = obj.event;

          if (evt?.type === "content_block_start") {
            const block = evt.content_block;
            currentBlockType = block?.type ?? null;

            if (block?.type === "thinking") {
              process.stderr.write("\n[claude] thinking: ");
            } else if (block?.type === "tool_use") {
              currentToolName = block.name ?? "unknown";
              toolInputBuf = "";
              process.stderr.write(`\n[claude] tool_use: ${currentToolName}(`);
            } else if (block?.type === "text") {
              process.stderr.write("\n[claude] generating text");
            }
          } else if (evt?.type === "content_block_delta") {
            const delta = evt.delta;

            if (currentBlockType === "thinking" && delta?.type === "thinking_delta") {
              const text = delta.thinking ?? "";
              process.stderr.write(text.length > 80 ? "." : text);
            } else if (currentBlockType === "tool_use" && delta?.type === "input_json_delta") {
              toolInputBuf += delta.partial_json ?? "";
            } else if (currentBlockType === "text" && delta?.type === "text_delta") {
              textChunks++;
              if (textChunks % 5 === 0) {
                process.stderr.write(".");
              }
            }
          } else if (evt?.type === "content_block_stop") {
            if (currentBlockType === "tool_use") {
              const inputPreview =
                toolInputBuf.length > 200 ? toolInputBuf.slice(0, 200) + "..." : toolInputBuf;
              process.stderr.write(`${inputPreview})`);
              currentToolName = null;
              toolInputBuf = "";
            }
            currentBlockType = null;
          }
        } else if (obj.type === "result") {
          callbacks.onResult?.(obj.result ?? "");
        }
      } catch {
        // skip malformed lines
      }
    }
  });

  return { getTextChunks: () => textChunks };
}

async function runClaude(preamble: string, prompt: string): Promise<string> {
  const input = `${preamble}\n\n---\n\n${prompt}`;
  console.log(
    `[claude] running | preamble: ${preamble.length} chars | prompt: ${prompt.length} chars`,
  );

  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = execa(
    CLAUDE_BIN,
    [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--system-prompt",
      SYSTEM_PROMPT_OVERRIDE,
      "--no-session-persistence",
      "--model",
      "sonnet",
      "--tools",
      "",
      "--effort",
      "low",
    ],
    {
      env,
      input,
      extendEnv: false,
      stdout: "pipe",
    },
  );

  let result = "";
  const { getTextChunks } = streamNdjsonProgress(proc.stdout!, {
    onResult: (r) => {
      result = r;
    },
  });

  await proc;
  process.stderr.write("\n");

  console.log(`[claude] result: ${result.trim().length} chars (${getTextChunks()} text chunks)`);
  return result;
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

// --GROK--: Standalone review for callers that batch multiple updateSpec calls
// with skipReview and want to review once at the end (e.g. resetBranch).
export async function reviewSpecDir(dir: string): Promise<void> {
  const content = readSpec(dir);
  if (!content?.trim()) {
    return;
  }
  const reviewed = await reviewSpec(content);
  if (!reviewed.trim()) {
    throw new Error("review pass returned empty result");
  }
  writeSpec(dir, reviewed);
}

const MAX_EXCERPT_CHARS = 300_000;

// Reads the current spec from disk (if any), combines it with new conversation
// excerpts, and asks Claude to produce an updated spec. If excerpts exceed
// MAX_EXCERPT_CHARS, they are split into chunks and processed sequentially —
// each chunk reads the spec back from disk (as updated by the previous chunk).
export async function updateSpec(
  messages: JsonlMessage[],
  dir: string,
  opts: { skipReview?: boolean } = {},
): Promise<void> {
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

    // --GROK--: readSpec concatenates all .feature files in the directory.
    // The LLM sees a single string — file boundaries are invisible.
    const currentSpec = readSpec(dir);

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

    let output = result;
    if (!opts.skipReview) {
      const reviewed = await reviewSpec(result);
      if (!reviewed.trim()) {
        throw new Error("review pass returned empty result");
      }
      output = reviewed;
    }

    // --GROK--: writeSpec splits the output by Feature: blocks, slugifies
    // each name, rm's existing .feature files, and writes the new ones.
    // Between chunk iterations, the next readSpec call will re-concat.
    writeSpec(dir, output);
  }
}

// --GROK--: specDir returns the directory where .feature files live. All
// branches share the same directory — specs describe product features, not
// branch-scoped work.
export function specDir(repoPath: string, scope?: string): string {
  const base = path.join(repoPath, ".machinen", "specs");
  return scope ? path.join(base, scope) : base;
}

// --GROK--: readSpec globs *.feature files, sorts alphabetically for
// deterministic ordering, and concatenates into a single string. The LLM
// pipeline only ever sees this concatenated string — file boundaries are
// invisible to it.
export function readSpec(dir: string): string | null {
  if (!fs.existsSync(dir)) {
    return null;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".feature"))
    .sort();

  if (files.length === 0) {
    return null;
  }

  const contents = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
  return contents.join("\n\n");
}

// --GROK--: slugify turns a Feature name into a filename-safe slug.
// "CLI spec update" → "cli-spec-update"
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --GROK--: writeSpec parses the Gherkin output by Feature: blocks, slugifies
// each feature name to determine the filename, removes all existing .feature
// files (clean slate — content was already consumed), and writes the new files.
export function writeSpec(dir: string, gherkin: string): void {
  fs.mkdirSync(dir, { recursive: true });

  // Remove existing .feature files
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith(".feature"));
  for (const f of existing) {
    fs.unlinkSync(path.join(dir, f));
  }

  // Split by Feature: blocks. Each block starts with "Feature:" at the
  // beginning of a line (possibly with leading whitespace).
  const blocks = gherkin.split(/(?=^Feature:\s)/m).filter((b) => b.trim());

  for (const block of blocks) {
    const match = block.match(/^Feature:\s*(.+)/m);
    if (!match) {
      continue;
    }
    const slug = slugify(match[1].trim());
    if (!slug) {
      continue;
    }
    fs.writeFileSync(path.join(dir, `${slug}.feature`), block.trimEnd() + "\n", "utf8");
  }
}
