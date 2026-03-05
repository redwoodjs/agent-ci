// --GROK--: Reusable e2e test harness for derive. Creates fully isolated temp
// directory structures (projects dir, repo dir, DB file) so tests never touch
// the real ~/.machinen/ or ~/.claude/ directories.
//
// Usage: import this module (side-effect registers afterEach cleanup), call
// setupDeriveTest() to get paths + a run() function, then assert on results.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { execa } from "execa";
import { afterEach } from "vitest";

// --GROK--: Module-level tracking of temp roots. The afterEach hook iterates
// this set and removes all temp directories, so individual tests never need
// to think about cleanup.
const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

export interface HarnessOptions {
  branch?: string;
  conversations?: Array<{
    id?: string;
    messages: Array<{
      type: "user" | "assistant";
      content: string;
    }>;
  }>;
  deriveArgs?: string[];
}

export interface HarnessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  specDir: string;
  repoDir: string;
  featureFiles: string[];
}

// --GROK--: Mirrors derive's getSlugDir — Claude Code replaces both / and _
// with - when computing the slug directory name for a given cwd.
function computeSlug(repoPath: string): string {
  return repoPath.replace(/[/_]/g, "-");
}

// --GROK--: Resolves paths relative to the repo root (three levels up from
// this file: e2e/ -> test/ -> derive/ -> repo root).
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DERIVE_ENTRY = path.join(REPO_ROOT, "derive", "src", "index.ts");
const FAKE_CLAUDE_BIN = path.join(REPO_ROOT, "derive", "test", "scripts", "fake-claude-gen-specs");

export async function setupDeriveTest(opts: HarnessOptions = {}): Promise<{
  repoDir: string;
  projectsDir: string;
  dbPath: string;
  specDir: string;
  run: () => Promise<HarnessResult>;
}> {
  const branch = opts.branch ?? "test-branch";

  // --GROK--: Create a unique temp root. All test artifacts live under this
  // single directory, making cleanup a single rmSync call.
  // fs.realpathSync resolves macOS symlinks (/var -> /private/var, /tmp ->
  // /private/tmp). Without this, process.cwd() inside the subprocess returns
  // the real path but our slug is computed from the symlinked path, causing a
  // slug dir mismatch and zero conversations discovered.
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "derive-test-")));
  tempRoots.add(tempRoot);

  const repoDir = path.join(tempRoot, "repo");
  const projectsDir = path.join(tempRoot, "projects");
  const dbPath = path.join(tempRoot, "machinen.db");

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  // --GROK--: git init + create a branch + initial commit so that derive's
  // getCurrentBranch() (which calls `git rev-parse --abbrev-ref HEAD`) works.
  // Without an initial commit, HEAD doesn't exist and rev-parse fails.
  execSync("git init", { cwd: repoDir, stdio: "ignore" });
  execSync(`git checkout -b ${branch}`, { cwd: repoDir, stdio: "ignore" });
  execSync("git commit --allow-empty -m 'init'", { cwd: repoDir, stdio: "ignore" });

  // --GROK--: Write synthetic JSONL conversations. The slug dir under
  // projectsDir must match what derive's getSlugDir(repoDir) would compute.
  const slug = computeSlug(repoDir);
  const slugDir = path.join(projectsDir, slug);
  fs.mkdirSync(slugDir, { recursive: true });

  const conversations = opts.conversations ?? [];
  for (const conv of conversations) {
    const id = conv.id ?? crypto.randomUUID();
    const lines = conv.messages.map((m) =>
      JSON.stringify({
        type: m.type,
        sessionId: "test-session",
        cwd: repoDir,
        gitBranch: branch,
        message: {
          role: m.type === "user" ? "user" : "assistant",
          content: m.content,
        },
      }),
    );
    fs.writeFileSync(path.join(slugDir, `${id}.jsonl`), lines.join("\n") + "\n", "utf8");
  }

  const specDir = path.join(repoDir, ".machinen", "specs");

  async function run(): Promise<HarnessResult> {
    const args = opts.deriveArgs ?? [];

    // --GROK--: Spawn derive as a subprocess with full env isolation.
    // CLAUDE_BIN points to the deterministic stub, CLAUDE_PROJECTS_DIR to our
    // temp projects dir, MACHINEN_DB to a temp file. This ensures zero contact
    // with the real ~/.machinen/ or ~/.claude/ directories.
    const result = await execa(
      path.join(REPO_ROOT, "node_modules", ".bin", "tsx"),
      [DERIVE_ENTRY, ...args],
      {
        cwd: repoDir,
        env: {
          ...process.env,
          CLAUDE_BIN: FAKE_CLAUDE_BIN,
          CLAUDE_PROJECTS_DIR: projectsDir,
          MACHINEN_DB: dbPath,
        },
        reject: false,
      },
    );

    // --GROK--: Read back the .feature files that derive wrote (if any).
    let featureFiles: string[] = [];
    if (fs.existsSync(specDir)) {
      featureFiles = fs
        .readdirSync(specDir)
        .filter((f) => f.endsWith(".feature"))
        .map((f) => path.join(specDir, f))
        .sort();
    }

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      specDir,
      repoDir,
      featureFiles,
    };
  }

  return { repoDir, projectsDir, dbPath, specDir, run };
}
