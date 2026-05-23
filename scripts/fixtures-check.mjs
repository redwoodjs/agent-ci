#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = path.join(root, "crates/agent-ci/fixtures");
const plansDir = path.join(fixturesRoot, "plans");
const workflowsDir = path.join(fixturesRoot, "workflows");
const eventsDir = path.join(fixturesRoot, "events");
const runResultsDir = path.join(fixturesRoot, "run-results");
const dockerSocketDir = path.join(fixturesRoot, "docker-socket");

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

const eventFiles = checkEventFixtures();
const runResultFiles = checkRunResultFixtures();
const dockerSocketFiles = checkDockerSocketFixtures();

console.log(`✓ ${planFiles.length} TypeScript fixture plan contracts passed`);
console.log(`✓ ${eventFiles} TypeScript fixture event contracts passed`);
console.log(`✓ ${runResultFiles} TypeScript fixture run-result contracts passed`);
console.log(`✓ ${dockerSocketFiles} TypeScript fixture docker-socket contracts passed`);

function fixtureFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
}

function normalizeEvent(event) {
  const clone = { ...event };
  delete clone.ts;
  delete clone.runId;
  delete clone.durationMs;
  delete clone.logPath;
  delete clone.debugLogPath;
  return clone;
}

function checkEventFixtures() {
  const files = fixtureFiles(eventsDir);
  if (files.length === 0) {
    throw new Error("Expected at least one event fixture");
  }
  for (const file of files) {
    const fixture = readJson(path.join(eventsDir, file));
    const actual = fixture.input.map(normalizeEvent);
    assertJsonEqual(actual, fixture.normalized, `event fixture ${file}`);
  }
  return files.length;
}

function normalizeRunResult(result) {
  const clone = JSON.parse(JSON.stringify(result));
  delete clone.worktreePath;
  delete clone.startedAt;
  delete clone.finishedAt;
  delete clone.headSha;
  for (const job of clone.jobs ?? []) {
    delete job.durationMs;
    delete job.debugLogPath;
    for (const step of job.steps ?? []) {
      delete step.logPath;
    }
  }
  return clone;
}

function checkRunResultFixtures() {
  const files = fixtureFiles(runResultsDir);
  if (files.length === 0) {
    throw new Error("Expected at least one run-result fixture");
  }
  for (const file of files) {
    const fixture = readJson(path.join(runResultsDir, file));
    assertJsonEqual(
      normalizeRunResult(fixture.input),
      fixture.normalized,
      `run-result fixture ${file}`,
    );
  }
  return files.length;
}

function resolveDockerSocket(probe) {
  const envHost = probe.env?.AGENT_CI_DOCKER_HOST?.trim();
  if (envHost) {
    if (!envHost.startsWith("unix://")) {
      return { socketPath: "", uri: envHost, bindMountPath: "" };
    }
    const socketPath = envHost.slice("unix://".length);
    const resolved = resolveSocketPath(probe, socketPath);
    if (resolved) {
      return { socketPath: resolved, uri: `unix://${resolved}`, bindMountPath: socketPath };
    }
    throw new Error(`AGENT_CI_DOCKER_HOST=${envHost} does not resolve to a working socket.`);
  }

  if (!pathExists(probe, "/var/run/docker.sock")) {
    throw new Error(
      [
        "/var/run/docker.sock is missing or a dangling symlink",
        dockerDesktopHint(probe),
        "docs/docker-socket.md",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const defaultResolved = resolveSocketPath(probe, "/var/run/docker.sock");
  if (defaultResolved) {
    return {
      socketPath: defaultResolved,
      uri: `unix://${defaultResolved}`,
      bindMountPath: "/var/run/docker.sock",
    };
  }

  const contextHost = probe.dockerContextHost;
  if (contextHost?.startsWith("unix://")) {
    const socketPath = contextHost.slice("unix://".length);
    if (pathExists(probe, socketPath)) {
      return {
        socketPath,
        uri: `unix://${socketPath}`,
        bindMountPath: "/var/run/docker.sock",
      };
    }
  }
  throw new Error("/var/run/docker.sock exists but is not readable\ndocs/docker-socket.md");
}

function pathExists(probe, socketPath) {
  return (probe.existingPaths ?? []).includes(socketPath);
}

function resolveSocketPath(probe, socketPath) {
  const resolved = probe.realpaths?.[socketPath] ?? socketPath;
  return pathExists(probe, socketPath) && (probe.accessiblePaths ?? []).includes(resolved)
    ? resolved
    : undefined;
}

function dockerDesktopHint(probe) {
  const home = probe.home;
  if (home && pathExists(probe, path.join(home, ".docker/run/docker.sock"))) {
    return "Docker Desktop is running but the default socket is disabled";
  }
  return "";
}

function checkDockerSocketFixtures() {
  const files = fixtureFiles(dockerSocketDir);
  if (files.length === 0) {
    throw new Error("Expected at least one docker-socket fixture");
  }
  for (const file of files) {
    const fixture = readJson(path.join(dockerSocketDir, file));
    try {
      const actual = resolveDockerSocket(fixture.probe);
      if (!fixture.expected) {
        throw new Error(`Expected fixture to fail, got ${JSON.stringify(actual)}`);
      }
      assertJsonEqual(actual, fixture.expected, `docker-socket fixture ${file}`);
    } catch (error) {
      if (fixture.expected) {
        throw error;
      }
      for (const expected of fixture.expectedErrorContains ?? []) {
        if (!String(error.message).includes(expected)) {
          throw new Error(
            `docker-socket fixture ${file} error did not contain ${expected}: ${error.message}`,
          );
        }
      }
    }
  }
  return files.length;
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`Fixture mismatch: ${label}`);
    console.error("Expected:", JSON.stringify(expected, null, 2));
    console.error("Actual:", JSON.stringify(actual, null, 2));
    process.exit(1);
  }
}
