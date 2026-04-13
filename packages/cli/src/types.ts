import type { WorkflowService, WorkflowContainer } from "./workflow/workflow-parser.js";

export interface Job {
  deliveryId: string;
  eventType: string;
  repository?: {
    owner?: {
      login: string;
    };
    name: string;
    full_name?: string;
    default_branch?: string;
  };
  env?: Record<string, string>;
  githubJobId?: string | number;
  githubRepo?: string;
  githubToken?: string;
  localSync?: boolean;
  localPath?: string;
  headSha?: string;
  runnerName?: string;
  steps?: any[];
  services?: WorkflowService[];
  container?: WorkflowContainer;
  taskId?: string;
  workflowPath?: string;
  /** Top-level workflow path for display grouping (when workflowPath is a reusable callee) */
  parentWorkflowPath?: string;
  [key: string]: any;
}
