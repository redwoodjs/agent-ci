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
import path from "node:path";
import YAML from "yaml";
import { parseWorkflowSteps } from "../packages/cli/src/workflow/workflow-parser.ts";

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

type Drift = {
  file: string;
  job: string;
  stepIndex: number;
  stepLabel: string;
  key: StepKey;
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

async function diffWorkflow(filePath: string): Promise<Drift[]> {
  const text = await fs.readFile(filePath, "utf8");
  const raw = YAML.parse(text);
  if (!raw?.jobs) {
    return [];
  }

  const drifts: Drift[] = [];

  for (const [jobId, rawJob] of Object.entries(raw.jobs)) {
    const job = rawJob as Record<string, unknown>;
    const rawSteps = job.steps as Record<string, unknown>[] | undefined;
    if (!Array.isArray(rawSteps)) {
      continue;
    }

    let parsedSteps: ParsedStep[];
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

async function main() {
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
    "A drift is a step-level YAML key present in the workflow file that our",
    "`parseWorkflowSteps` silently dropped, with no documented expected-drop",
    "policy. Expected drops (tracked separately) are:",
    "",
  ];
  for (const [key, reason] of Object.entries(EXPECTED_DROP)) {
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
        reportLines.push(
          `- job \`${d.job}\`, step ${d.stepIndex} (${d.stepLabel}): key \`${d.key}\` = \`${d.rawValue}\` not carried into parser output`,
        );
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
