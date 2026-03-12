import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { ConversationRecord, BranchRecord } from "./types.js";

const DB_PATH = process.env.AGENT_CI_DB ?? path.join(os.homedir(), ".agent-ci", "agent-ci.db");

function initDb(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id   TEXT PRIMARY KEY,
      repo_path         TEXT NOT NULL,
      branch            TEXT NOT NULL,
      jsonl_path        TEXT NOT NULL,
      last_line_offset  INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branches (
      repo_path              TEXT NOT NULL,
      branch                 TEXT NOT NULL,
      spec_path              TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      PRIMARY KEY (repo_path, branch)
    );
  `);
  return db;
}

export const db = initDb();

export function upsertConversation(record: ConversationRecord): void {
  db.prepare(
    `
    INSERT INTO conversations (conversation_id, repo_path, branch, jsonl_path, last_line_offset, updated_at)
    VALUES (@conversationId, @repoPath, @branch, @jsonlPath, @lastLineOffset, @updatedAt)
    ON CONFLICT (conversation_id) DO UPDATE SET
      repo_path        = excluded.repo_path,
      branch           = excluded.branch,
      jsonl_path       = excluded.jsonl_path,
      last_line_offset = excluded.last_line_offset,
      updated_at       = excluded.updated_at
  `,
  ).run({
    conversationId: record.conversationId,
    repoPath: record.repoPath,
    branch: record.branch,
    jsonlPath: record.jsonlPath,
    lastLineOffset: record.lastLineOffset,
    updatedAt: record.updatedAt,
  });
}

export function getConversation(conversationId: string): ConversationRecord | null {
  const row = db
    .prepare(`SELECT * FROM conversations WHERE conversation_id = ?`)
    .get(conversationId) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return rowToConversation(row);
}

export function getConversationsForBranch(repoPath: string, branch: string): ConversationRecord[] {
  const rows = db
    .prepare(`SELECT * FROM conversations WHERE repo_path = ? AND branch = ?`)
    .all(repoPath, branch) as Record<string, unknown>[];
  return rows.map(rowToConversation);
}

export function upsertBranch(record: BranchRecord): void {
  db.prepare(
    `
    INSERT INTO branches (repo_path, branch, spec_path, updated_at)
    VALUES (@repoPath, @branch, @specPath, @updatedAt)
    ON CONFLICT (repo_path, branch) DO UPDATE SET
      spec_path  = excluded.spec_path,
      updated_at = excluded.updated_at
  `,
  ).run({
    repoPath: record.repoPath,
    branch: record.branch,
    specPath: record.specPath,
    updatedAt: record.updatedAt,
  });
}

export function getBranch(repoPath: string, branch: string): BranchRecord | null {
  const row = db
    .prepare(`SELECT * FROM branches WHERE repo_path = ? AND branch = ?`)
    .get(repoPath, branch) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    repoPath: row["repo_path"] as string,
    branch: row["branch"] as string,
    specPath: row["spec_path"] as string,
    updatedAt: row["updated_at"] as string,
  };
}

export function resetConversationOffsets(repoPath: string, branch: string): number {
  const result = db
    .prepare(
      `UPDATE conversations SET last_line_offset = 0, updated_at = @updatedAt
       WHERE repo_path = @repoPath AND branch = @branch`,
    )
    .run({
      repoPath,
      branch,
      updatedAt: new Date().toISOString(),
    });
  return Number(result.changes);
}

function rowToConversation(row: Record<string, unknown>): ConversationRecord {
  return {
    conversationId: row["conversation_id"] as string,
    repoPath: row["repo_path"] as string,
    branch: row["branch"] as string,
    jsonlPath: row["jsonl_path"] as string,
    lastLineOffset: row["last_line_offset"] as number,
    updatedAt: row["updated_at"] as string,
  };
}
