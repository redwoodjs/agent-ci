import fs from "fs";
import crypto from "crypto";
import {
  parseWorkflow,
  NoOperationTraceWriter,
  convertWorkflowTemplate,
} from "@actions/workflow-parser";
import { minimatch } from "minimatch";

export async function getWorkflowTemplate(filePath: string) {
  const content = fs.readFileSync(filePath, "utf8");
  const result = parseWorkflow({ name: filePath, content }, new NoOperationTraceWriter());

  if (result.value === undefined) {
    throw new Error(
      `Failed to parse workflow: ${result.context.errors
        .getErrors()
        .map((e) => e.message)
        .join(", ")}`,
    );
  }

  return await convertWorkflowTemplate(result.context, result.value);
}

export async function parseWorkflowSteps(filePath: string, taskName: string) {
  const template = await getWorkflowTemplate(filePath);

  // Find the job by ID or Name
  const job = template.jobs.find((j) => {
    if (j.type !== "job") {
      return false;
    }
    return j.id.toString() === taskName || (j.name && j.name.toString() === taskName);
  });

  if (!job || job.type !== "job") {
    throw new Error(`Task "${taskName}" not found in workflow "${filePath}"`);
  }

  return job.steps
    .map((step, index) => {
      const stepId = step.id || `step-${index + 1}`;
      let stepName = step.name ? step.name.toString() : stepId;

      // Fix for __actions_checkout issue
      // If a step uses an action but has no name, @actions/workflow-parser might auto-generate a name like __actions_checkout
      // which causes the runner to treat it as a special internal step expecting specific inputs.
      // We force a display name if one isn't provided.
      if (!step.name && (step as any).uses) {
        stepName = (step as any).uses.toString();
      }

      if ("run" in step) {
        return {
          Type: "Action",
          Name: stepName,
          DisplayName: stepName,
          Id: crypto.randomUUID(),
          Reference: {
            Type: "Script",
          },
          Inputs: {
            script: step.run.toString(),
          },
        };
      } else if ("uses" in step) {
        // Basic support for 'uses' steps
        // Parse uses string: owner/repo@ref
        const uses = step.uses.toString();
        let name = uses;
        let ref = "";

        if (uses.indexOf("@") >= 0) {
          const parts = uses.split("@");
          name = parts[0];
          ref = parts[1];
        }

        const isCheckout = name.trim().toLowerCase() === "actions/checkout";

        return {
          Type: "Action",
          Name: stepName,
          DisplayName: stepName,
          Id: crypto.randomUUID(),
          Reference: {
            Type: "Repository",
            Name: name,
            Ref: ref,
            RepositoryType: "GitHub",
            Path: "",
          },
          Inputs: {
            // with: values from @actions/workflow-parser are expression objects; call toString() on each.
            ...((step as any).with
              ? Object.fromEntries(
                  Object.entries((step as any).with).map(([k, v]) => [k, String(v)]),
                )
              : {}),
            ...(isCheckout
              ? {
                  clean: "false",
                  "fetch-depth": "0",
                  lfs: "false",
                  submodules: "false",
                }
              : {}), // Prevent actions/checkout from wiping the rsynced workspace
          },
        };
      }
      return null;
    })
    .filter(Boolean);
}

export function isWorkflowRelevant(template: any, branch: string) {
  const events = template.events;
  if (!events) {
    return false;
  }

  // 1. Check pull_request
  if (events.pull_request) {
    const pr = events.pull_request;
    // If pull_request has branch filters, check if 'main' (target) is included.
    // This simulates a PR being raised against main.
    if (!pr.branches && !pr["branches-ignore"]) {
      return true; // No filters, matches all PRs
    }

    if (pr.branches) {
      if (pr.branches.some((pattern: string) => minimatch("main", pattern))) {
        return true;
      }
    }

    if (pr["branches-ignore"]) {
      if (!pr["branches-ignore"].some((pattern: string) => minimatch("main", pattern))) {
        return true;
      }
    }
  }

  // 2. Check push
  if (events.push) {
    const push = events.push;
    if (!push.branches && !push["branches-ignore"]) {
      return true; // No filters, matches all pushes
    }

    if (push.branches) {
      if (push.branches.some((pattern: string) => minimatch(branch, pattern))) {
        return true;
      }
    }

    if (push["branches-ignore"]) {
      if (!push["branches-ignore"].some((pattern: string) => minimatch(branch, pattern))) {
        return true;
      }
    }
  }

  return false;
}
