// A parsed line from a JSONL conversation file — only user/assistant records
export type JsonlMessage = {
  type: "user" | "assistant";
  sessionId: string;
  cwd: string;
  gitBranch: string;
  timestamp?: string;
  message: {
    role: "user" | "assistant";
    // Content is an array of blocks in current Claude API format, but older
    // conversation files or simple messages may store it as a plain string.
    content: string | Array<{ type: string; text?: string }>;
  };
};

// A row in the conversations table
export type ConversationRecord = {
  conversationId: string;
  repoPath: string;
  branch: string;
  jsonlPath: string;
  lastLineOffset: number;
  updatedAt: string;
};

// A row in the branches table
export type BranchRecord = {
  repoPath: string;
  branch: string;
  specPath: string;
  updatedAt: string;
};
