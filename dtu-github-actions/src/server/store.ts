import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const CACHE_DIR = config.DTU_CACHE_DIR;
const CACHES_FILE = path.join(CACHE_DIR, "caches.json");

export const state = {
  jobs: new Map<string, any>(),
  // Per-runner job queue: runnerName → job payload (for multi-job concurrency)
  runnerJobs: new Map<string, any>(),
  sessions: new Map<string, any>(),
  messageQueues: new Map<string, any[]>(),
  pendingPolls: new Map<string, { res: http.ServerResponse; baseUrl: string }>(),
  logs: new Map<string, string[]>(),

  // Concurrency Maps
  // runnerName -> logDirectory
  runnerLogs: new Map<string, string>(),
  // runnerName -> timeline directory (supervisor's _/logs/<runnerName>/)
  runnerTimelineDirs: new Map<string, string>(),
  // sessionId -> runnerName
  sessionToRunner: new Map<string, string>(),
  // planId -> step-output.log path
  planToLogPath: new Map<string, string>(),
  // timelineId -> runner log directory (for persisting timeline.json)
  timelineToLogDir: new Map<string, string>(),

  // Substring patterns for cache keys that should always return a synthetic hit
  // with an empty archive (e.g. "pnpm" for bind-mounted pnpm stores).
  virtualCachePatterns: new Set<string>(),

  // cacheKey -> { version: string, archiveLocation: string, size: number }
  caches: new Map<string, { version: string; archiveLocation: string; size: number }>(),
  // cacheId (number) -> { tempPath: string, key: string, version: string }
  pendingCaches: new Map<number, { tempPath: string; key: string; version: string }>(),

  // artifactName -> { containerId: number, files: Map<itemPath, diskPath> }
  artifacts: new Map<string, { containerId: number; files: Map<string, string> }>(),
  // containerId -> { name: string, files: Map<itemPath, diskPath> }
  pendingArtifacts: new Map<number, { name: string; files: Map<string, string> }>(),

  isVirtualCacheKey(key: string): boolean {
    for (const pattern of this.virtualCachePatterns) {
      if (key.includes(pattern)) {
        return true;
      }
    }
    return false;
  },

  loadCachesFromDisk() {
    if (fs.existsSync(CACHES_FILE)) {
      try {
        const data = fs.readFileSync(CACHES_FILE, "utf-8");
        const parsed = JSON.parse(data);
        this.caches = new Map(Object.entries(parsed));
      } catch (e) {
        console.warn("[DTU] Failed to load caches from disk:", e);
      }
    }
  },

  saveCachesToDisk() {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    try {
      const obj = Object.fromEntries(this.caches);
      fs.writeFileSync(CACHES_FILE, JSON.stringify(obj, null, 2), "utf-8");
    } catch (e) {
      console.warn("[DTU] Failed to save caches to disk:", e);
    }
  },

  reset() {
    this.jobs.clear();
    this.runnerJobs.clear();
    this.sessions.clear();
    this.messageQueues.clear();
    this.pendingPolls.clear();
    this.logs.clear();
    this.runnerLogs.clear();
    this.runnerTimelineDirs.clear();
    this.sessionToRunner.clear();
    this.planToLogPath.clear();
    this.timelineToLogDir.clear();
    this.virtualCachePatterns.clear();
    this.caches.clear();
    this.pendingCaches.clear();
    this.artifacts.clear();
    this.pendingArtifacts.clear();
  },
};

// Auto-load on startup
state.loadCachesFromDisk();
