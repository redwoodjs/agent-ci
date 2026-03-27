import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";

export const LOCAL_WORKFLOW_SUPPORT_ISSUE_URL = "https://github.com/redwoodjs/agent-ci/issues/93";
export const COMPATIBILITY_DOC_URL = "https://agent-ci.dev/compatibility";

function buildUnsupportedMessage(params: {
  workflowName: string;
  feature: string;
  jobId?: string;
}): string {
  const scope = params.jobId
    ? ` in job "${params.jobId}" from workflow "${params.workflowName}"`
    : ` in workflow "${params.workflowName}"`;
  return `${params.feature} is not supported${scope}.`;
}

function buildIgnoredUnsupportedSummary(messages: string[]): string {
  return [
    "[Agent CI]",
    "Ignore locally:",
    ...messages.map((message) => `- ${message}`),
    `See compatibility: ${COMPATIBILITY_DOC_URL}`,
  ].join("\n");
}

function buildBlockingUnsupportedMessage(params: {
  workflowName: string;
  feature: string;
  jobId?: string;
  workaround: string;
  trackIssue?: string;
}): string {
  const lines = [`[Agent CI] ${buildUnsupportedMessage(params)}`];

  if (params.trackIssue) {
    lines.push(`  • See Progress: ${params.trackIssue}`);
  }

  lines.push(`  • Workaround: ${params.workaround}`);

  return lines.join("\n");
}

function workflowUsesWorkflowCall(rawOn: unknown): boolean {
  if (!rawOn || typeof rawOn !== "object" || Array.isArray(rawOn)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(rawOn, "workflow_call");
}

function throwUnsupported(params: Parameters<typeof buildBlockingUnsupportedMessage>[0]): never {
  const message = buildBlockingUnsupportedMessage(params);
  throw new Error(message);
}

function warnUnsupported(
  params: Parameters<typeof buildUnsupportedMessage>[0],
  warnings: string[],
  emitWarnings: boolean,
): void {
  if (emitWarnings) {
    warnings.push(buildUnsupportedMessage(params));
  }
}

export function assertNoUnsupportedFeatures(
  filePath: string,
  taskName?: string,
  options?: { emitWarnings?: boolean },
): void {
  const workflowName = path.basename(filePath);
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const emitWarnings = options?.emitWarnings ?? true;
  const warnings: string[] = [];
  const flushWarnings = () => {
    if (emitWarnings && warnings.length > 0) {
      console.warn(`\n${buildIgnoredUnsupportedSummary(warnings)}`);
      warnings.length = 0;
    }
  };

  if (!yaml || typeof yaml !== "object") {
    return;
  }

  const root = yaml as Record<string, unknown>;

  if (root.concurrency != null) {
    warnUnsupported(
      {
        workflowName,
        feature: "Workflow-level concurrency",
      },
      warnings,
      emitWarnings,
    );
  }

  if (workflowUsesWorkflowCall(root.on)) {
    flushWarnings();
    throwUnsupported({
      workflowName,
      feature: "Reusable workflow trigger `on.workflow_call`",
      workaround:
        "For now, run this file as a standalone workflow instead of calling it via `workflow_call`.",
      trackIssue: LOCAL_WORKFLOW_SUPPORT_ISSUE_URL,
    });
  }

  const jobs = yaml?.jobs;

  if (!jobs || typeof jobs !== "object") {
    return;
  }

  for (const [jobId, jobDef] of Object.entries(jobs)) {
    if (taskName && jobId !== taskName) {
      continue;
    }

    if (!jobDef || typeof jobDef !== "object") {
      continue;
    }

    const job = jobDef as Record<string, unknown>;

    if (job["timeout-minutes"] != null) {
      warnUnsupported(
        {
          workflowName,
          jobId,
          feature: "Job-level timeout `timeout-minutes`",
        },
        warnings,
        emitWarnings,
      );
    }

    if (job["continue-on-error"] != null) {
      warnUnsupported(
        {
          workflowName,
          jobId,
          feature: "Job-level `continue-on-error`",
        },
        warnings,
        emitWarnings,
      );
    }

    if (job.concurrency != null) {
      warnUnsupported(
        {
          workflowName,
          jobId,
          feature: "Job-level concurrency",
        },
        warnings,
        emitWarnings,
      );
    }

    if (job.secrets != null) {
      warnUnsupported(
        {
          workflowName,
          jobId,
          feature: "Job-level `secrets`",
        },
        warnings,
        emitWarnings,
      );
    }

    const strategy = job.strategy;
    if (strategy && typeof strategy === "object" && !Array.isArray(strategy)) {
      const strategyObj = strategy as Record<string, unknown>;

      if (strategyObj["max-parallel"] != null) {
        warnUnsupported(
          {
            workflowName,
            jobId,
            feature: "Matrix `strategy.max-parallel`",
          },
          warnings,
          emitWarnings,
        );
      }

      const matrix = strategyObj.matrix;
      if (matrix && typeof matrix === "object" && !Array.isArray(matrix)) {
        const matrixObj = matrix as Record<string, unknown>;
        if (matrixObj.include != null || matrixObj.exclude != null) {
          warnUnsupported(
            {
              workflowName,
              jobId,
              feature: "Matrix `include`/`exclude`",
            },
            warnings,
            emitWarnings,
          );
        }
      }
    }

    const uses = job.uses;
    if (typeof uses === "string") {
      const reusableKind =
        uses.startsWith("./") || uses.startsWith("/")
          ? "Local reusable workflow"
          : "Reusable workflow";
      flushWarnings();
      throwUnsupported({
        workflowName,
        jobId,
        feature: `${reusableKind} "${uses}"`,
        workaround: "For now, move the reusable workflow logic into this workflow job's `steps`.",
        trackIssue: LOCAL_WORKFLOW_SUPPORT_ISSUE_URL,
      });
    }

    const steps = job.steps;
    if (!Array.isArray(steps)) {
      continue;
    }

    for (const step of steps) {
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        continue;
      }
      const stepObj = step as Record<string, unknown>;

      const stepUses = stepObj.uses;
      if (typeof stepUses === "string" && (stepUses.startsWith("./") || stepUses.startsWith("/"))) {
        flushWarnings();
        throwUnsupported({
          workflowName,
          jobId,
          feature: `Local composite action "${stepUses}"`,
          workaround: `For now, move the logic from "${stepUses}" into workflow "${workflowName}" job "${jobId}" steps.`,
          trackIssue: LOCAL_WORKFLOW_SUPPORT_ISSUE_URL,
        });
      }

      if (stepObj["continue-on-error"] != null) {
        warnUnsupported(
          {
            workflowName,
            jobId,
            feature: "Step-level `continue-on-error`",
          },
          warnings,
          emitWarnings,
        );
      }

      if (stepObj["timeout-minutes"] != null) {
        warnUnsupported(
          {
            workflowName,
            jobId,
            feature: "Step-level timeout `timeout-minutes`",
          },
          warnings,
          emitWarnings,
        );
      }
    }
  }

  flushWarnings();
}

export function assertNoUnsupportedReusableWorkflowJobs(filePath: string): void {
  assertNoUnsupportedFeatures(filePath);
}
