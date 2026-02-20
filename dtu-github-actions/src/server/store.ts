import http from "node:http";

export const state = {
  jobs: new Map<string, any>(),
  sessions: new Map<string, any>(),
  messageQueues: new Map<string, any[]>(),
  pendingPolls: new Map<string, { res: http.ServerResponse; baseUrl: string }>(),
  timelines: new Map<string, any[]>(),
  logs: new Map<string, string[]>(),

  // Concurrency Maps
  // runnerName -> logDirectory
  runnerLogs: new Map<string, string>(),
  // sessionId -> runnerName
  sessionToRunner: new Map<string, string>(),
  // planId -> step-output.log path
  planToLogPath: new Map<string, string>(),

  reset() {
    this.jobs.clear();
    this.sessions.clear();
    this.messageQueues.clear();
    this.pendingPolls.clear();
    this.timelines.clear();
    this.logs.clear();
    this.runnerLogs.clear();
    this.sessionToRunner.clear();
    this.planToLogPath.clear();
  },
};
