// Rescore saved transcripts against the current rubric without re-running
// the agent. Useful when you change a rubric pattern and want to see what
// the existing data says about the corrected check.
//
// Usage:
//   node rescore.mjs [--variant <name>] [--fixture <name>] [--last-n <N>]
//
// Looks at all trials under $TMPDIR/skill-eval-*, reads each trial's
// `_meta.json` + `_streams.json`, re-runs `score()` against the current
// `fixtures/<name>/expect.yaml`, aggregates, and writes scorecard-replay.md.

import { execa } from "execa";
import { readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { score } from "./scorers/grep.mjs";
import { aggregate, renderMarkdown } from "./scorecard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = parseArgs(process.argv.slice(2));

const { stdout } = await execa(
  "find",
  [tmpdir(), "-maxdepth", "4", "-name", "skill-eval-*", "-type", "d"],
  { reject: false },
);
const allDirs = stdout.split("\n").filter(Boolean);

// Collect trials with a valid _meta.json + _streams.json sidecar.
const trials = [];
for (const d of allDirs) {
  const meta = await readJson(join(d, "_meta.json"));
  const streams = await readJson(join(d, "_streams.json"));
  if (!meta || !streams) {
    continue;
  }
  if (argv.variant && meta.variant !== argv.variant) {
    continue;
  }
  if (argv.fixture && meta.fixture !== argv.fixture) {
    continue;
  }
  trials.push({ dir: d, meta, streams });
}

if (!trials.length) {
  console.error("no saved trials found (nothing to rescore)");
  process.exit(1);
}

// Group by (variant, fixture) and re-score each using the fixture's *current* rubric.
const cells = new Map();
for (const t of trials) {
  const key = `${t.meta.variant}::${t.meta.fixture}`;
  if (!cells.has(key)) {
    cells.set(key, { variant: t.meta.variant, fixture: t.meta.fixture, trials: [] });
  }
  cells.get(key).trials.push(t);
}

// Sort trials within each cell by timestamp (newest first), optionally trim to --last-n.
const lastN = argv["last-n"] ? Number(argv["last-n"]) : Infinity;
for (const cell of cells.values()) {
  cell.trials.sort((a, b) => (b.meta.timestamp ?? "").localeCompare(a.meta.timestamp ?? ""));
  cell.trials = cell.trials.slice(0, lastN);
}

const scored = [];
for (const cell of cells.values()) {
  const expect = parseYaml(
    await readFile(join(here, "fixtures", cell.fixture, "expect.yaml"), "utf8"),
  );
  const scoredTrials = cell.trials.map((t) => ({
    rubric: score(expect.rubric, t.streams),
    groundTruth: t.meta.groundTruth,
    timestamp: t.meta.timestamp,
    dir: t.dir,
  }));
  const agg = aggregate({ variant: cell.variant, fixture: cell.fixture, trials: scoredTrials });
  scored.push(agg);
  console.log(`▶ ${cell.variant} × ${cell.fixture}  (N=${scoredTrials.length})`);
  console.log(`  full-rubric ${agg.fullRubricPasses}/${agg.n}, CI ${agg.ciPasses}/${agg.n}`);
  for (const p of agg.perItem) {
    console.log(`    ${p.passes}/${p.trials}  ${p.id}`);
  }
}

await writeFile(join(here, "scorecard-replay.json"), JSON.stringify(scored, null, 2));
await writeFile(
  join(here, "scorecard-replay.md"),
  renderMarkdown(scored, { heading: "Scorecard (replayed)" }),
);
console.log(`\nwrote scorecard-replay.json, scorecard-replay.md`);

async function readJson(path) {
  try {
    const s = await stat(path);
    if (!s.isFile()) {
      return null;
    }
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
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
