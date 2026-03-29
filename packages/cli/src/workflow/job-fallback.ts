import fs from "fs";
import YAML from "yaml";

export function getWorkflowJobsWithFallback(template: any, workflowPath: string) {
  if (Array.isArray(template?.jobs)) {
    return template.jobs.filter((j: any) => j.type === "job");
  }

  const rawJobs = (YAML.parse(fs.readFileSync(workflowPath, "utf8"))?.jobs ?? {}) as Record<
    string,
    any
  >;
  return Object.entries(rawJobs).map(([id, rawJob]) => ({
    type: "job",
    id,
    name: rawJob?.name ?? id,
  }));
}
