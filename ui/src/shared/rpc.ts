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
      selectProject: {
        params: void;
        response: string | null;
      };
      getRecentProjects: {
        params: void;
        response: string[];
      };
      getWorkflows: {
        params: { projectPath: string };
        response: { id: string; name: string }[];
      };
      runWorkflow: {
        params: { projectPath: string; workflowId: string };
        response: string | null;
      };
      stopWorkflow: {
        params: void;
        response: boolean;
      };
      getRunCommits: {
        params: { projectPath: string };
        response: { id: string; label: string; date: number }[];
      };
      getWorkflowsForCommit: {
        params: { projectPath: string; commitId: string };
        response: {
          runId: string;
          workflowName: string;
          status: "Passed" | "Failed" | "Running" | "Unknown";
          date: number;
        }[];
      };
      getRunDetails: {
        params: { runId: string };
        response: { logs: string; status: "Passed" | "Failed" | "Running" | "Unknown" } | null;
      };
      getAppState: {
        params: void;
        response: { projectPath: string; commitId: string };
      };
      setAppState: {
        params: { projectPath?: string; commitId?: string };
        response: void;
      };
      getDtuStatus: {
        params: void;
        response: boolean;
      };
      getRunOnCommitEnabled: {
        params: { projectPath: string };
        response: boolean;
      };
      toggleRunOnCommit: {
        params: { projectPath: string; enabled: boolean };
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
