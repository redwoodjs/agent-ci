export type MyRPCSchema = {
  bun: {
    requests: {
      selectRepo: {
        params: void;
        response: string | null;
      };
      getInitialState: {
        params: void;
        response: {
          repoPath: string;
          branchName: string;
        };
      };
      getBranches: {
        params: void;
        response: { name: string; isCurrent: boolean; isRemote: boolean; lastCommitDate: number }[];
      };
      getCommits: {
        params: { branch: string };
        response: { id: string; label: string; author: string; date: number }[];
      };
      getWorkingTreeDirty: {
        params: void;
        response: boolean;
      };
      openRunInFinder: {
        params: { runId: string };
        response: void;
      };
      setActiveRunId: {
        params: { runId: string };
        response: void;
      };
      getActiveRunId: {
        params: void;
        response: string;
      };
      getRunDetail: {
        params: { runId: string };
        response: {
          runId: string;
          runnerName: string;
          workflowName: string;
          jobName?: string | null;
          status: string;
          date: number;
          endDate?: number;
          repoPath?: string;
          commitId?: string;
          taskId?: string;
          workflowRunId?: string;
          attempt?: number;
          warmCache?: boolean;
          logsPath?: string;
        } | null;
      };
      getRunLogs: {
        params: { runId: string };
        response: string;
      };
      getRunTimeline: {
        params: { runId: string };
        response: any[];
      };
      getRunErrors: {
        params: { runId: string };
        response: { severity: string; message: string; line: number; context: string[] }[];
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
