#!/usr/bin/env -S node --experimental-strip-types
// Differential parse check.
//
// For each .github/workflows/*.yml, read the raw YAML and ask our
// parseWorkflowSteps to produce its post-processed view. For every
// step-level key the raw YAML declares, confirm the parser preserves
// its semantics in the produced Step (either by carrying the value
// forward or by applying a documented expected-drop policy).
//
// A "drift" is a key the raw YAML uses that our parser silently drops
// without a documented policy — the class of bug the default.run
// working-directory gap (#290) belonged to before it had a smoke.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  getWorkflowTemplate,
  parseWorkflowSteps,
} from "../packages/cli/src/workflow/workflow-parser.ts";

// Step-level keys GitHub Actions recognizes. Source: the "steps context" and
// workflow syntax docs. If a key shows up in raw YAML and is not in this list,
// we don't grade it either way.
const STEP_KEYS = [
  "id",
  "name",
  "run",
  "uses",
  "with",
  "env",
  "if",
  "working-directory",
  "shell",
  "continue-on-error",
  "timeout-minutes",
] as const;

type StepKey = (typeof STEP_KEYS)[number];

// Known-and-documented expected drops. Anything here is listed in
// compatibility.json as `unsupported` or `not-planned`; our parser
// intentionally does not carry it forward. Adding a key here is a
// conscious "yes, we drop this" declaration.
const EXPECTED_DROP: Record<string, string> = {
  "continue-on-error": "unsupported — see compatibility.json",
  "timeout-minutes": "unsupported — see compatibility.json",
  shell: "partial / runner ignores inputs.shell — tracked by #293",
};

// For each recognized step-level YAML key, a predicate on the parsed Step
// that returns true when the parser carried the key's semantics forward.
// These predicates describe *structural* preservation, not semantic equality —
// we just check "did we keep it at all?"
const PRESERVED: Record<StepKey, (parsed: ParsedStep) => boolean> = {
  id: (p) => p.ContextName !== undefined && p.ContextName !== null,
  name: (p) => typeof p.Name === "string" && p.Name.length > 0,
  run: (p) => typeof p.Inputs?.script === "string" && p.Inputs.script.length > 0,
  uses: (p) =>
    p.Reference?.Type === "Repository" && (Boolean(p.Reference.Name) || Boolean(p.Reference.Path)),
  with: (p) => {
    if (!p.Inputs) {
      return false;
    }
    const keys = Object.keys(p.Inputs).filter(
      (k) => k !== "script" && k !== "workingDirectory" && k !== "shell",
    );
    return keys.length > 0;
  },
  env: (p) => typeof p.Env === "object" && p.Env !== null && Object.keys(p.Env).length > 0,
  if: () => true, // runner-evaluated at runtime — see compatibility.json
  "working-directory": (p) => typeof p.Inputs?.workingDirectory === "string",
  shell: (p) => typeof p.Inputs?.shell === "string",
  "continue-on-error": () => false,
  "timeout-minutes": () => false,
};

type ParsedStep = {
  Name?: string;
  ContextName?: string;
  Reference?: { Type?: string; Name?: string; Path?: string; Ref?: string };
  Inputs?: Record<string, string>;
  Env?: Record<string, string>;
};

// Job-level keys GitHub Actions recognizes. See "jobs.<job_id>" in
// workflow-syntax-for-github-actions.
const JOB_KEYS = [
  "name",
  "runs-on",
  "needs",
  "if",
  "env",
  "defaults",
  "outputs",
  "container",
  "services",
  "strategy",
  "environment",
  "permissions",
  "concurrency",
  "uses",
  "secrets",
  "timeout-minutes",
  "continue-on-error",
] as const;

type JobKey = (typeof JOB_KEYS)[number];

const JOB_EXPECTED_DROP: Record<string, string> = {
  "timeout-minutes": "unsupported — see compatibility.json",
  "continue-on-error": "unsupported — see compatibility.json",
  concurrency: "not-planned — see compatibility.json",
  environment: "ignored — see compatibility.json",
  permissions: "ignored — see compatibility.json",
};

// Predicate: did our pipeline recognize this key? The canonical signal is
// "does the official workflow template (which our parser wraps) expose the
// key for this job?". Values come back as TemplateToken objects, so we
// check presence only — structural preservation, not value equality.
// Behavioral regressions are covered by smokes.
const JOB_PRESERVED: Record<JobKey, (templateJob: Record<string, unknown>) => boolean> = {
  name: (t) => t.name != null,
  "runs-on": (t) => t["runs-on"] != null,
  needs: (t) => t.needs != null,
  if: (t) => t.if != null,
  env: (t) => t.env != null,
  outputs: (t) => t.outputs != null,
  container: (t) => t.container != null,
  services: (t) => t.services != null,
  strategy: (t) => t.strategy != null,
  // The template does not expose a `defaults` field — its children propagate
  // into steps. Correctness of that propagation is covered by
  // smoke-defaults-workdir and smoke-shell-defaults, not by this diff.
  defaults: () => true,
  // Reusable-workflow caller jobs. The template may not surface these the
  // same way as inline jobs, but our reusable-workflow path handles them.
  uses: () => true,
  secrets: () => true,
  environment: () => false, // expected drop
  permissions: () => false, // expected drop
  concurrency: () => false, // expected drop
  "timeout-minutes": () => false,
  "continue-on-error": () => false,
};

// Workflow-top-level keys GitHub Actions recognizes. This catalog is the
// "did we think about this?" list — behavioural correctness for each is
// covered elsewhere (step/job scans, smokes). A raw top-level key that
// appears in a workflow but is absent from this catalog AND the
// expected-drop list is flagged — that's the signal for "GitHub grew a
// new top-level key we have not considered yet."
const WORKFLOW_KEYS = new Set([
  "name",
  "run-name",
  "on",
  "permissions",
  "env",
  "defaults",
  "concurrency",
  "jobs",
]);

const WORKFLOW_EXPECTED_DROP: Record<string, string> = {
  "run-name": "ignored — see compatibility.json",
  permissions: "ignored — see compatibility.json",
  concurrency: "not-planned — see compatibility.json",
};

type Drift = {
  file: string;
  scope: "workflow" | "job" | "step";
  job: string | null;
  stepIndex: number | null;
  stepLabel: string | null;
  key: string;
  rawValue: string;
};

function shortLabel(rawStep: Record<string, unknown>): string {
  if (typeof rawStep.name === "string") {
    return rawStep.name;
  }
  if (typeof rawStep.uses === "string") {
    return `uses: ${rawStep.uses}`;
  }
  if (typeof rawStep.run === "string") {
    const first = rawStep.run.split("\n")[0].trim();
    return `run: ${first.slice(0, 40)}${first.length > 40 ? "…" : ""}`;
  }
  return "?";
}

function summarize(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  }
  return JSON.stringify(value).slice(0, 40);
}

async function diffWorkflow(
  filePath: string,
  overrides?: {
    parsedSteps?: Map<string, ParsedStep[]>;
    templateJobs?: Map<string, Record<string, unknown>>;
  },
): Promise<Drift[]> {
  const text = await fs.readFile(filePath, "utf8");
  const raw = YAML.parse(text);
  if (!raw?.jobs) {
    return [];
  }

  // Load the template once for job-level preservation checks.
  const templateJobsById = new Map<string, Record<string, unknown>>();
  if (overrides?.templateJobs) {
    for (const [id, j] of overrides.templateJobs) {
      templateJobsById.set(id, j);
    }
  } else {
    try {
      const template = (await getWorkflowTemplate(filePath)) as {
        jobs?: Array<Record<string, unknown>>;
      };
      for (const j of template.jobs ?? []) {
        // j.id is a TemplateToken, not a plain string — coerce via String().
        const id = j.id != null ? String(j.id) : undefined;
        if (id) {
          templateJobsById.set(id, j);
        }
      }
    } catch (err) {
      console.error(`  template fetch failed: ${(err as Error).message}`);
    }
  }

  const drifts: Drift[] = [];

  // ── Workflow-top-level scan ─────────────────────────────────────────────
  for (const key of Object.keys(raw)) {
    if (key in WORKFLOW_EXPECTED_DROP) {
      continue;
    }
    if (WORKFLOW_KEYS.has(key)) {
      continue;
    }
    drifts.push({
      file: filePath,
      scope: "workflow",
      job: null,
      stepIndex: null,
      stepLabel: null,
      key,
      rawValue: summarize(raw[key]),
    });
  }

  for (const [jobId, rawJob] of Object.entries(raw.jobs)) {
    const job = rawJob as Record<string, unknown>;

    // ── Job-level scan ─────────────────────────────────────────────────────
    const templateJob = templateJobsById.get(jobId);
    for (const key of JOB_KEYS) {
      const value = job[key];
      if (value === undefined || value === null || value === "") {
        continue;
      }
      if (key in JOB_EXPECTED_DROP) {
        continue;
      }
      if (templateJob && JOB_PRESERVED[key](templateJob)) {
        continue;
      }
      drifts.push({
        file: filePath,
        scope: "job",
        job: jobId,
        stepIndex: null,
        stepLabel: null,
        key,
        rawValue: summarize(value),
      });
    }

    // ── Step-level scan ────────────────────────────────────────────────────
    const rawSteps = job.steps as Record<string, unknown>[] | undefined;
    if (!Array.isArray(rawSteps)) {
      continue;
    }

    let parsedSteps: ParsedStep[];
    if (overrides?.parsedSteps?.has(jobId)) {
      parsedSteps = overrides.parsedSteps.get(jobId)!;
    } else {
      try {
        parsedSteps = (await parseWorkflowSteps(filePath, jobId)) as ParsedStep[];
      } catch (err) {
        // Reusable workflow callers have `uses:` at job level and no steps for us to parse.
        // Skip those without noise.
        if (job.uses) {
          continue;
        }
        console.error(`  skip ${jobId}: ${(err as Error).message}`);
        continue;
      }
    }

    for (let i = 0; i < rawSteps.length; i++) {
      const rawStep = rawSteps[i];
      const parsedStep = parsedSteps[i];
      if (!parsedStep) {
        continue;
      }

      for (const key of STEP_KEYS) {
        const value = rawStep[key];
        if (value === undefined || value === null || value === "") {
          continue;
        }
        if (PRESERVED[key](parsedStep)) {
          continue;
        }
        if (key in EXPECTED_DROP) {
          continue;
        }
        drifts.push({
          file: filePath,
          scope: "step",
          job: jobId,
          stepIndex: i,
          stepLabel: shortLabel(rawStep),
          key,
          rawValue: summarize(value),
        });
      }
    }
  }

  return drifts;
}

// Confirm the detector itself is working: feed a fixture through the real
// parser (expect 0 drifts) and through a synthesized parser-output that
// omits `working-directory` (expect exactly 1 drift for that key). Without
// this, "0 drifts" from a real run could mean either "clean" or "probe is
// silently broken".
async function runSelfTest(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "diff-parse-selftest-"));
  try {
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    await fs.mkdir(workflowsDir, { recursive: true });
    const fixture = path.join(workflowsDir, "fixture.yml");
    await fs.writeFile(
      fixture,
      `name: selftest
on: push
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: step with working-directory
        working-directory: /tmp/selftest
        run: echo hi
`,
    );

    const goodDrifts = await diffWorkflow(fixture);
    if (goodDrifts.length !== 0) {
      throw new Error(
        `self-test case 1 (real parser): expected 0 drifts, got ${goodDrifts.length}`,
      );
    }

    // Case 2: hand the detector a parsed-step that's missing workingDirectory.
    // This simulates a regression where the parser silently stops preserving
    // step-level `working-directory`. The detector must flag it.
    const regression = new Map<string, ParsedStep[]>([
      [
        "j",
        [
          {
            Name: "step with working-directory",
            Inputs: { script: "echo hi" },
          },
        ],
      ],
    ]);
    const regressionDrifts = await diffWorkflow(fixture, { parsedSteps: regression });
    const stepRegressionDrifts = regressionDrifts.filter((d) => d.scope === "step");
    if (stepRegressionDrifts.length !== 1 || stepRegressionDrifts[0].key !== "working-directory") {
      throw new Error(
        `self-test case 2 (injected step regression): expected 1 step drift on 'working-directory', got ${JSON.stringify(stepRegressionDrifts)}`,
      );
    }

    // Case 3: synthesize a template-job that's missing `runs-on`. The
    // detector must flag it as a job-scope drift. This is the job-level
    // analogue of case 2.
    const jobRegression = new Map<string, Record<string, unknown>>([
      [
        "j",
        {
          id: "j",
          // Note: missing `runs-on`.
          steps: [],
        },
      ],
    ]);
    const jobRegressionDrifts = await diffWorkflow(fixture, {
      parsedSteps: regression,
      templateJobs: jobRegression,
    });
    const jobDrifts = jobRegressionDrifts.filter((d) => d.scope === "job");
    if (jobDrifts.length !== 1 || jobDrifts[0].key !== "runs-on") {
      throw new Error(
        `self-test case 3 (injected job regression): expected 1 job drift on 'runs-on', got ${JSON.stringify(jobDrifts)}`,
      );
    }

    // Case 4: workflow scope — write a second fixture with an unrecognized
    // top-level key and confirm the detector flags it. Uses a real file
    // (not an override) so the workflow-scope path is exercised end-to-end.
    const wfFixture = path.join(workflowsDir, "workflow-unknown.yml");
    await fs.writeFile(
      wfFixture,
      `name: selftest-wf
on: push
hypothetical-new-key: someValue
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
    );
    const wfDrifts = await diffWorkflow(wfFixture);
    const wfScopeDrifts = wfDrifts.filter((d) => d.scope === "workflow");
    if (wfScopeDrifts.length !== 1 || wfScopeDrifts[0].key !== "hypothetical-new-key") {
      throw new Error(
        `self-test case 4 (unknown top-level key): expected 1 workflow drift on 'hypothetical-new-key', got ${JSON.stringify(wfScopeDrifts)}`,
      );
    }

    console.log(
      "self-test passed: known-good → 0 drifts; step regression → 1 on working-directory; job regression → 1 on runs-on; workflow unknown key → 1 on hypothetical-new-key",
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const workflowsDir = path.join(repoRoot, ".github/workflows");
  const entries = await fs.readdir(workflowsDir);
  const files = entries
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(workflowsDir, f))
    .sort();

  const allDrifts: Drift[] = [];
  for (const file of files) {
    const relFile = path.relative(repoRoot, file);
    console.error(`… ${relFile}`);
    try {
      const drifts = await diffWorkflow(file);
      allDrifts.push(...drifts);
    } catch (err) {
      console.error(`  error: ${(err as Error).message}`);
    }
  }

  const reportLines = [
    "# Differential parse report",
    "",
    `Scanned ${files.length} workflows. ${allDrifts.length} drift(s) found.`,
    "",
    "A drift is a YAML key (step- or job-level) present in the workflow file",
    "that our pipeline silently dropped without a documented expected-drop",
    "policy. Expected drops (tracked separately) are:",
    "",
    "**Step scope:**",
  ];
  for (const [key, reason] of Object.entries(EXPECTED_DROP)) {
    reportLines.push(`- \`${key}\` — ${reason}`);
  }
  reportLines.push("", "**Job scope:**");
  for (const [key, reason] of Object.entries(JOB_EXPECTED_DROP)) {
    reportLines.push(`- \`${key}\` — ${reason}`);
  }
  reportLines.push("", "**Workflow scope:**");
  for (const [key, reason] of Object.entries(WORKFLOW_EXPECTED_DROP)) {
    reportLines.push(`- \`${key}\` — ${reason}`);
  }
  reportLines.push("", "## Drifts", "");

  if (allDrifts.length === 0) {
    reportLines.push("_None._");
  } else {
    const byFile = new Map<string, Drift[]>();
    for (const d of allDrifts) {
      const rel = path.relative(repoRoot, d.file);
      const list = byFile.get(rel) ?? [];
      list.push(d);
      byFile.set(rel, list);
    }
    for (const [rel, list] of byFile) {
      reportLines.push(`### ${rel}`);
      reportLines.push("");
      for (const d of list) {
        if (d.scope === "step") {
          reportLines.push(
            `- [step] job \`${d.job}\`, step ${d.stepIndex} (${d.stepLabel}): key \`${d.key}\` = \`${d.rawValue}\` not carried into parser output`,
          );
        } else if (d.scope === "job") {
          reportLines.push(
            `- [job ] job \`${d.job}\`: key \`${d.key}\` = \`${d.rawValue}\` not exposed by workflow template`,
          );
        } else {
          reportLines.push(
            `- [wf  ] top-level key \`${d.key}\` = \`${d.rawValue}\` not in recognized workflow-level key catalog`,
          );
        }
      }
      reportLines.push("");
    }
  }

  console.log(reportLines.join("\n"));
  process.exit(allDrifts.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
