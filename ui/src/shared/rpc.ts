export type MyRPCSchema = {
  bun: {
    requests: {
      launchDTU: {
        params: void;
        response: boolean;
      };
      stopDTU: {
        params: void;
        response: boolean;
      };
      selectRepo: {
        params: void;
        response: string | null;
      };
      getRecentRepos: {
        params: void;
        response: string[];
      };
      getWorkflows: {
        params: { repoPath: string };
        response: { id: string; name: string }[];
      };
      runWorkflow: {
        params: { repoPath: string; workflowId: string; commitId?: string };
        response: string | null;
      };
      stopWorkflow: {
        params: void;
        response: boolean;
      };
      getRunCommits: {
        params: { repoPath: string };
        response: { id: string; label: string; date: number }[];
      };
      getWorkflowsForCommit: {
        params: { repoPath: string; commitId: string };
        response: {
          runId: string;
          workflowName: string;
          status: "Passed" | "Failed" | "Running" | "Unknown";
          date: number;
        }[];
      };
      getBranches: {
        params: { repoPath: string };
        response: { name: string; isCurrent: boolean }[];
      };
      getGitCommits: {
        params: { repoPath: string; branch: string };
        response: { id: string; label: string; date: number; author: string }[];
      };
      getWorkingTreeStatus: {
        params: { repoPath: string };
        response: boolean;
      };
      getRunDetails: {
        params: { runId: string };
        response: { logs: string; status: "Passed" | "Failed" | "Running" | "Unknown" } | null;
      };
      getAppState: {
        params: void;
        response: {
          repoPath: string;
          branchName: string;
          commitId: string;
          workflowId: string;
          runId: string;
        };
      };
      setAppState: {
        params: {
          repoPath?: string;
          branchName?: string;
          commitId?: string;
          workflowId?: string;
          runId?: string;
        };
        response: void;
      };
      getDtuStatus: {
        params: void;
        response: "Stopped" | "Starting" | "Running";
      };
      getRunOnCommitEnabled: {
        params: { repoPath: string };
        response: boolean;
      };
      toggleRunOnCommit: {
        params: { repoPath: string; enabled: boolean };
        response: void;
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      dtuLog: string;
    };
  };
};
