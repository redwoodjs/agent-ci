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
  const rawYaml = (await import("yaml")).parse(fs.readFileSync(filePath, "utf8"));

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

  const rawJob = rawYaml.jobs?.[taskName] || {};
  const rawSteps = rawJob.steps || [];

  return job.steps
    .map((step, index) => {
      const stepId = step.id || `step-${index + 1}`;
      let stepName = step.name ? step.name.toString() : stepId;
      const rawStep = rawSteps[index] || {};

      // Fix for __actions_checkout issue
      // If a step uses an action but has no name, @actions/workflow-parser might auto-generate a name like __actions_checkout
      // which causes the runner to treat it as a special internal step expecting specific inputs.
      // We force a display name if one isn't provided.
      if (!step.name && (step as any).uses) {
        stepName = (step as any).uses.toString();
      }

      if ("run" in step) {
        const inputs: Record<string, string> = {
          script: step.run.toString(),
        };
        if (rawStep["working-directory"]) {
          inputs.workingDirectory = rawStep["working-directory"];
        }
        return {
          Type: "Action",
          Name: stepName,
          DisplayName: stepName,
          Id: crypto.randomUUID(),
          Reference: {
            Type: "Script",
          },
          Inputs: inputs,
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
        const stepWith = rawStep.with || {};

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
            // Merge from raw YAML
            ...Object.fromEntries(Object.entries(stepWith).map(([k, v]) => [k, String(v)])),
            ...(isCheckout
              ? {
                  clean: "false",
                  "fetch-depth": "0",
                  lfs: "false",
                  submodules: "false",
                  ...Object.fromEntries(Object.entries(stepWith).map(([k, v]) => [k, String(v)])),
                }
              : {}), // Prevent actions/checkout from wiping the rsynced workspace
          },
        };
      }
      return null;
    })
    .filter(Boolean);
}

export interface WorkflowService {
  name: string;
  image: string;
  env?: Record<string, string>;
  ports?: string[];
  options?: string;
}

export async function parseWorkflowServices(
  filePath: string,
  taskName: string,
): Promise<WorkflowService[]> {
  const rawYaml = (await import("yaml")).parse(fs.readFileSync(filePath, "utf8"));
  const rawJob = rawYaml.jobs?.[taskName] || {};
  const rawServices = rawJob.services;
  if (!rawServices || typeof rawServices !== "object") {
    return [];
  }

  return Object.entries(rawServices).map(([name, def]: [string, any]) => {
    const svc: WorkflowService = {
      name,
      image: def.image || "",
    };
    if (def.env && typeof def.env === "object") {
      svc.env = Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, String(v)]));
    }
    if (Array.isArray(def.ports)) {
      svc.ports = def.ports.map(String);
    }
    if (def.options) {
      svc.options = String(def.options);
    }
    return svc;
  });
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
