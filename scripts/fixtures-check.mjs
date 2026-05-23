#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = path.join(root, "crates/agent-ci/fixtures");
const plansDir = path.join(fixturesRoot, "plans");
const workflowsDir = path.join(fixturesRoot, "workflows");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readWorkflow(file) {
  return YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
}

function asArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function formatRunsOn(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  if (value && typeof value === "object") {
    const labels = value.labels;
    if (Array.isArray(labels)) {
      return labels.map(String).join(", ");
    }
    if (typeof labels === "string") {
      return labels;
    }
  }
  return undefined;
}

function targetForJob(job) {
  if (job.uses) {
    return `reusable:${job.uses}`;
  }
  const runsOn = formatRunsOn(job["runs-on"]);
  if (!runsOn) {
    return "unknown";
  }
  return runsOn.toLowerCase().includes("macos") ? `macos:${runsOn}` : `linux:${runsOn}`;
}

function matrixCombos(matrix, noMatrix) {
  if (!matrix || typeof matrix !== "object") {
    return [null];
  }
  const axes = Object.entries(matrix).filter(
    ([key, value]) => key !== "include" && key !== "exclude" && Array.isArray(value),
  );
  if (axes.length === 0) {
    return [null];
  }
  const combos = noMatrix
    ? [Object.fromEntries(axes.map(([key, values]) => [key, String(values[0])]))]
    : axes.reduce(
        (acc, [key, values]) =>
          acc.flatMap((combo) => values.map((value) => ({ ...combo, [key]: String(value) }))),
        [{}],
      );
  return combos.map((combo, index) => ({
    __job_index: String(index),
    __job_total: String(combos.length),
    ...combo,
  }));
}

function serviceIds(job) {
  const services = job.services;
  if (!services || typeof services !== "object") {
    return [];
  }
  return Object.keys(services).sort();
}

function containerImage(job) {
  const container = job.container;
  if (!container) {
    return null;
  }
  if (typeof container === "string") {
    return container;
  }
  if (typeof container === "object" && container.image) {
    return String(container.image);
  }
  return null;
}

function outputKeys(job) {
  const outputs = job.outputs;
  if (!outputs || typeof outputs !== "object") {
    return [];
  }
  return Object.keys(outputs).sort();
}

function scheduleKey(job) {
  return job.matrix ? job.runnerName : job.id;
}

function scheduleJobWaves(jobs) {
  const expandedById = new Map();
  for (const job of jobs) {
    if (!expandedById.has(job.id)) {
      expandedById.set(job.id, []);
    }
    expandedById.get(job.id).push(scheduleKey(job));
  }

  const remaining = new Map(
    jobs.map((job) => [
      scheduleKey(job),
      job.needs.flatMap((need) => expandedById.get(need) ?? [need]),
    ]),
  );
  const completed = new Set();
  const waves = [];
  while (remaining.size > 0) {
    const wave = [...remaining.entries()]
      .filter(([, needs]) => needs.every((need) => completed.has(need)))
      .map(([key]) => key);
    if (wave.length === 0) {
      waves.push([...remaining.keys()]);
      break;
    }
    for (const key of wave) {
      remaining.delete(key);
      completed.add(key);
    }
    waves.push(wave);
  }
  return waves;
}

function planWorkflow(workflow, args = {}) {
  const jobsObject = workflow.jobs && typeof workflow.jobs === "object" ? workflow.jobs : {};
  const jobs = [];
  const jobIds = Object.keys(jobsObject).sort();
  let jobNumber = 0;

  for (const jobId of jobIds) {
    const job = jobsObject[jobId] ?? {};
    const target = targetForJob(job);
    if (target === "unknown") {
      continue;
    }
    jobNumber += 1;
    const combos = matrixCombos(job.strategy?.matrix, args.noMatrix === true);
    const total = combos.length;
    combos.forEach((matrix, matrixIndex) => {
      const hasMatrix = matrix !== null;
      jobs.push({
        id: jobId,
        runnerName: hasMatrix
          ? `agent-ci-1-j${jobNumber}-m${matrixIndex + 1}`
          : `agent-ci-1-j${jobNumber}`,
        target,
        needs: asArray(job.needs),
        if: job.if == null ? null : String(job.if),
        matrix: hasMatrix ? matrix : null,
        outputs: outputKeys(job),
        services: serviceIds(job),
        container: containerImage(job),
      });
    });
    if (total === 0) {
      throw new Error(`matrix expansion produced no jobs for ${jobId}`);
    }
  }

  return { jobs, schedule: scheduleJobWaves(jobs) };
}

const planFiles = fs
  .readdirSync(plansDir)
  .filter((file) => file.endsWith(".json"))
  .sort();

if (planFiles.length < 10) {
  throw new Error(`Expected at least 10 plan fixtures, found ${planFiles.length}`);
}

const failures = [];
for (const planFile of planFiles) {
  const expected = readJson(path.join(plansDir, planFile));
  const workflowPath = path.join(workflowsDir, expected.workflow);
  const actual = planWorkflow(readWorkflow(workflowPath), expected.args ?? {});
  const expectedPlan = expected.plan;
  if (JSON.stringify(actual) !== JSON.stringify(expectedPlan)) {
    failures.push({ planFile, actual, expected: expectedPlan });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`Fixture mismatch: ${failure.planFile}`);
    console.error("Expected:", JSON.stringify(failure.expected, null, 2));
    console.error("Actual:", JSON.stringify(failure.actual, null, 2));
  }
  process.exit(1);
}

console.log(`✓ ${planFiles.length} TypeScript fixture plan contracts passed`);
