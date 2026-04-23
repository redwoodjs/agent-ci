// Skill-eval harness entry.
// Matrix: variants × fixtures → scorecard.json + scorecard.md
//
// Usage: pnpm eval [--variant <name>] [--fixture <name>] [--n <trials>]

import { execa } from "execa";
import { cp, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { extractStreams, run as runClaude } from "./runners/claude-code.mjs";
import { score } from "./scorers/grep.mjs";
import { aggregate, renderMarkdown } from "./scorecard.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const argv = parseArgs(process.argv.slice(2));
const N = Number(argv.n ?? 3);

const variants = await listDir(join(here, "variants"), argv.variant, ".md");
const fixtures = await listDir(join(here, "fixtures"), argv.fixture);

if (!variants.length) {
  throw new Error("no variants found");
}
if (!fixtures.length) {
  throw new Error("no fixtures found");
}

const cells = [];

for (const variant of variants) {
  for (const fixture of fixtures) {
    console.log(`\n▶ ${variant.name} × ${fixture.name}  (N=${N})`);
    const trials = [];
    for (let i = 0; i < N; i++) {
      process.stdout.write(`  trial ${i + 1}/${N}… `);
      const trial = await evalOne({ variant, fixture });
      trials.push(trial);
      const passed = trial.rubric.filter((r) => r.pass).length;
      const gt = trial.groundTruth ? (trial.groundTruth.passed ? "CI✓" : "CI✗") : "";
      console.log(`rubric ${passed}/${trial.rubric.length} ${gt}`);
    }
    const cell = aggregate({ variant: variant.name, fixture: fixture.name, trials });
    cells.push(cell);
    summarize(cell);
  }
}

await writeFile(join(here, "scorecard.json"), JSON.stringify(cells, null, 2));
await writeFile(join(here, "scorecard.md"), renderMarkdown(cells));
console.log(`\nwrote scorecard.json, scorecard.md`);

async function evalOne({ variant, fixture }) {
  const workdir = await mkdtemp(join(tmpdir(), `skill-eval-${fixture.name}-`));
  await cp(join(fixture.path, "repo"), workdir, { recursive: true });

  await execa("npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: workdir });

  // Initialize as a real git repo so agents don't waste turns on `git status` recon.
  // Fixtures ship their own .gitignore (covers node_modules + package-lock.json).
  const g = (args) => execa("git", args, { cwd: workdir });
  await g(["init", "-q", "-b", "main"]);
  await g(["config", "user.email", "eval@example.com"]);
  await g(["config", "user.name", "Skill Eval"]);
  await g(["config", "commit.gpgsign", "false"]);
  await g(["add", "-A"]);
  await g(["commit", "-q", "-m", "fixture baseline"]);

  const { events, exitCode } = await runClaude({
    workdir,
    taskPath: join(fixture.path, "task.md"),
    variantPath: variant.path,
  });

  const streams = extractStreams(events);

  // persist raw transcript so we can diagnose failures after the fact
  await writeFile(join(workdir, "_events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
  await writeFile(join(workdir, "_streams.json"), JSON.stringify(streams, null, 2));

  const expect = parseYaml(await readFile(join(fixture.path, "expect.yaml"), "utf8"));
  const rubric = score(expect.rubric, streams);

  let groundTruth = null;
  if (expect.ground_truth?.cmd) {
    const [cmd, ...cmdArgs] = expect.ground_truth.cmd;
    const res = await execa(cmd, cmdArgs, { cwd: workdir, reject: false });
    groundTruth = { exitCode: res.exitCode, passed: res.exitCode === 0 };
  }

  // Sidecar metadata enables rescore.mjs to replay this trial against a
  // modified rubric without re-running the agent.
  await writeFile(
    join(workdir, "_meta.json"),
    JSON.stringify(
      {
        variant: variant.name,
        fixture: fixture.name,
        timestamp: new Date().toISOString(),
        agentExitCode: exitCode,
        groundTruth,
      },
      null,
      2,
    ),
  );

  return { workdir, agentExitCode: exitCode, rubric, groundTruth };
}

function summarize(cell) {
  console.log(
    `  aggregate: full-rubric ${cell.fullRubricPasses}/${cell.n}, CI ${cell.ciPasses}/${cell.n}`,
  );
  for (const p of cell.perItem) {
    console.log(`    ${p.passes}/${p.trials}  ${p.id}`);
  }
}

async function listDir(dir, filter, ext) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => (ext ? e.isFile() && e.name.endsWith(ext) : e.isDirectory()))
    .map((e) => ({ name: ext ? e.name.replace(ext, "") : e.name, path: join(dir, e.name) }))
    .filter((e) => !filter || e.name === filter);
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      out[args[i].slice(2)] = args[i + 1];
    }
  }
  return out;
}
